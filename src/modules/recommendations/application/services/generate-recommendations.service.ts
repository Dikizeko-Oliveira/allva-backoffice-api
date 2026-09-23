import { Injectable, Logger } from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { resolveConflicts } from 'src/modules/recommendations/domain/conflict';
import { plan as planFor } from 'src/modules/recommendations/domain/policy/recommendation-policy';
import { findSuppression } from 'src/modules/recommendations/domain/suppression';
import type { RecommendationPlan } from 'src/modules/recommendations/domain/recommendation-plan';
import {
  RecommendationsRepositoryInterface,
  type PersistedRecommendation,
} from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { RecommendationTargetsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendation-targets.repository';

export type GenerationOutcome = {
  organizationId: string;
  adsEvaluated: number;
  planned: number;
  persisted: number;
  deferred: number;
  suppressed: number;
  advisory: number;
  /** Recusadas pelo índice parcial: já havia uma ativa para `(ad, kind)`. */
  alreadyActive: number;
  blockedReason: string | null;
};

/**
 * `GenerateRecommendationsUseCase` — os nove passos de §9.4, nesta ordem.
 *
 * Faz I/O e orquestra; **nenhuma decisão sobre o plano mora aqui**. Guardas,
 * resolução de nível, conflito, supressão e impacto são funções puras em
 * `domain/`, e é por isso que cada uma tem teste sem container.
 *
 * Dois passos são estruturais e fáceis de perder de vista:
 *
 * - **O passo 4 agrupa por ALVO DE AÇÃO, não por anúncio.** Deduplicar por
 *   `(ad, kind)` não evita conflito porque a ação frequentemente mira acima do
 *   anúncio: dois ads do mesmo conjunto geram `ADJUST_AD_SET_BUDGET` em direções
 *   opostas sobre a mesma entidade, ambos válidos isoladamente.
 * - **O passo 3d mantém o motor vivo.** Um motor que reapresenta amanhã o que o
 *   usuário rejeitou hoje não morre por errar — morre por não escutar.
 */
@Injectable()
export class GenerateRecommendationsService {
  private readonly logger = new Logger(GenerateRecommendationsService.name);

  constructor(
    private readonly targets: RecommendationTargetsRepositoryInterface,
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly events: DomainEventBus,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    organizationId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<GenerationOutcome> {
    const now = input.now ?? new Date();

    const outcome: GenerationOutcome = {
      organizationId: input.organizationId,
      adsEvaluated: 0,
      planned: 0,
      persisted: 0,
      deferred: 0,
      suppressed: 0,
      advisory: 0,
      alreadyActive: 0,
      blockedReason: null,
    };

    if (!this.env.get('RECOMMENDATION_ENGINE_ENABLED')) {
      outcome.blockedReason = 'FEATURE_DISABLED';
      return outcome;
    }

    const settings = await this.targets.settingsForOrganization(
      input.organizationId,
    );

    if (!settings) {
      throw new Error(`Organização ${input.organizationId} não encontrada`);
    }

    // §9.4 passo 1 — sync válido e sem recomputo de moeda em curso.
    if (!settings.generationAllowed) {
      outcome.blockedReason = settings.blockedReason;
      this.logger.warn(
        `recommendations.skipped organizationId=${input.organizationId} ` +
          `motivo=${settings.blockedReason}`,
      );
      return outcome;
    }

    // §9.4 passo 2.
    const signals = await this.targets.loadSignals({
      organizationId: input.organizationId,
      baseCurrency: settings.baseCurrency,
      thresholds: settings.thresholds,
      now,
    });

    if (signals.length === 0) return outcome;

    const [suppressions, scope] = await Promise.all([
      this.targets.activeSuppressions(input.organizationId),
      this.targets.scopeCounts(input.organizationId),
    ]);

    // §9.4 passo 3.
    const plans: RecommendationPlan[] = [];

    for (const signal of signals) {
      outcome.adsEvaluated += 1;

      for (const candidate of planFor(signal)) {
        // 3d — a supressão vem **depois** do plano existir, e não antes: é o
        // plano que diz qual `kind` seria oferecido, e é o `kind` que a
        // supressão silencia.
        const suppression = findSuppression(
          {
            kind: candidate.kind,
            adId: signal.ad.adId,
            adSetId: signal.ad.adSetId,
            campaignId: signal.ad.campaignId,
          },
          suppressions,
          now,
        );

        if (suppression) {
          outcome.suppressed += 1;
          continue;
        }

        plans.push(withScopeWarnings(candidate, scope));
      }
    }

    outcome.planned = plans.length;
    outcome.advisory = plans.filter((item) => item.advisory).length;

    // §9.4 passo 4.
    const conflicts = resolveConflicts(plans);
    const emit = { ...input.ctx, organizationId: input.organizationId };
    const persistedWinners: Array<PersistedRecommendation | null> = [];

    // §9.4 passos 5 e 6.
    for (const winner of conflicts.winners) {
      const persisted = await this.persist(winner, settings, null);
      persistedWinners.push(persisted);

      if (!persisted) {
        outcome.alreadyActive += 1;
        continue;
      }

      outcome.persisted += 1;
      this.events.emitFrom(emit, 'recommendation.generated', {
        adId: persisted.adId,
        recommendationId: persisted.id,
        kind: persisted.kind,
        // Vazio nas consultivas, que não têm ação — e o consumidor precisa
        // distinguir "não há ação" de "a ação não foi persistida".
        actionIds: persisted.actionIds,
      });
    }

    for (const item of conflicts.deferred) {
      const persisted = await this.persist(item.plan, settings, {
        conflictWithId: persistedWinners[item.winnerIndex]?.id ?? null,
        reason: item.reason,
      });

      if (!persisted) {
        outcome.alreadyActive += 1;
        continue;
      }

      outcome.deferred += 1;
    }

    this.logger.log(
      `recommendation.generated organizationId=${input.organizationId} ` +
        `planejadas=${outcome.planned} persistidas=${outcome.persisted} ` +
        `diferidas=${outcome.deferred} suprimidas=${outcome.suppressed}`,
    );

    return outcome;
  }

  private async persist(
    plan: RecommendationPlan,
    settings: {
      organizationId: string;
      accountId: string;
      baseCurrency: string;
      engineVersion: string;
    },
    deferral: { conflictWithId: string | null; reason: string } | null,
  ): Promise<PersistedRecommendation | null> {
    return this.recommendations.persistPlan({
      plan,
      organizationId: settings.organizationId,
      accountId: settings.accountId,
      // A moeda da conta vem do plano; a base, da organização (R-M).
      currency: (plan.evidence.currency as string) ?? settings.baseCurrency,
      baseCurrency: settings.baseCurrency,
      engineVersion: settings.engineVersion,
      deferral,
    });
  }
}

/**
 * O aviso de escopo (§9.2), preenchido com a contagem real.
 *
 * A política sabe **que** a ação incide acima do anúncio; só a aplicação sabe
 * sobre quantos. Sem o número, "afeta outros anúncios" é um aviso que ninguém
 * consegue dimensionar — e um aviso que não dimensiona é um aviso que se ignora.
 */
function withScopeWarnings(
  plan: RecommendationPlan,
  scope: {
    adsByAdSetId: Map<string, number>;
    adsByCampaignId: Map<string, number>;
  },
): RecommendationPlan {
  if (plan.actions.length === 0) return plan;

  return {
    ...plan,
    actions: plan.actions.map((action) => {
      if (action.targetEntityType === 'AD_SET') {
        const count = scope.adsByAdSetId.get(action.targetEntityId) ?? 1;
        return { ...action, scopeWarning: warningFor(count, 'conjunto') };
      }

      if (action.targetEntityType === 'CAMPAIGN') {
        const count = scope.adsByCampaignId.get(action.targetEntityId) ?? 1;
        return { ...action, scopeWarning: warningFor(count, 'campanha') };
      }

      return action;
    }),
  };
}

function warningFor(
  ads: number,
  level: 'conjunto' | 'campanha',
): string | null {
  if (ads <= 1) return null;
  // O artigo concorda com a palavra: "deste conjunto", "desta campanha". Texto
  // de tela errado é texto que o usuário lê como descuido — e este aviso existe
  // justamente para ele confiar no que está aprovando.
  const artigo = level === 'campanha' ? 'desta' : 'deste';
  return `Afeta os ${ads} anúncios ${artigo} ${level}, não apenas este.`;
}
