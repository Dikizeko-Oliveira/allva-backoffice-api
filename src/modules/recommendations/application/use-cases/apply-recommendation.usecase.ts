import { Injectable, NotFoundException } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { revalidate as revalidatePremise } from 'src/modules/recommendations/domain/premise';
import { PRIMARY_IMPACT_BY_KIND } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import {
  RecommendationsRepositoryInterface,
  type RecommendationView,
} from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { RecommendationOutcomesRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';
import { ApplyRecommendationDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { assertEngineEnabled } from './recommendation-read-use-cases';

/** Idade máxima da evidência antes de a premissa vencer (§9.5 passo 1). */
const EVIDENCE_MAX_AGE_DAYS = 3;

/**
 * `POST /recommendations/{id}/apply` — **revalidação de premissa e dry-run**.
 *
 * A escrita real mora em `platform-actions` desde A2-S9, e o controller da rota
 * mudou de módulo junto com ela (D3, rota ≠ módulo). O que continua aqui é o que
 * sempre foi de `recommendations`: o passo 1 de §9.5 e o plano que ele libera.
 *
 * > A recomendação é gerada num lote diário e aplicada quando o usuário clica,
 * > dias depois. No intervalo, conversões são re-declaradas retroativamente, o
 * > anúncio pode ter sido pausado na plataforma, o token pode ter expirado. Sem
 * > revalidação, o clique executa uma decisão tomada sobre um mundo que já não
 * > existe — e registra o resultado como acerto no dataset de P8.
 *
 * **O dry-run devolve a linha de base do outcome** (C8). Não é adorno: é o
 * mesmo snapshot que A2-S7 vai gravar na transação de `appliedAt`, montado pelo
 * mesmo código e visível antes de qualquer escrita. Reconstruir o "pré" dias
 * depois leria dado já re-declarado — o dataset de P8 nasceria contaminado
 * exatamente pelo fenômeno que o produto mede em toda parte.
 */
@Injectable()
export class ApplyRecommendationUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly outcomes: RecommendationOutcomesRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  /**
   * O passo 1 de §9.5, isolado — **a única porta para o plano**.
   *
   * `platform-actions` chama isto antes de escrever. Duplicar a revalidação lá
   * criaria duas definições de "a premissa ainda vale", e a que erra é sempre a
   * que ninguém revisita.
   */
  async revalidate(input: {
    organizationId: string;
    id: string;
  }): Promise<RecommendationView> {
    assertEngineEnabled(this.env);

    const recommendation = await this.recommendations.findOne(
      input.organizationId,
      input.id,
    );

    if (!recommendation) {
      throw new NotFoundException('Recomendação não encontrada');
    }

    if (recommendation.advisory) {
      throw new DomainError({
        code: 'RECOMMENDATION_IS_ADVISORY',
        category: 'UNSUPPORTED_BY_PLATFORM',
        message:
          'Esta recomendação é consultiva e não tem ação a aplicar pela Allva.',
        details: { outOfScopeReason: recommendation.outOfScopeReason },
        remediation:
          recommendation.guidance ??
          'Siga a orientação no gerenciador da plataforma.',
      });
    }

    const state = await this.recommendations.premiseStateFor({
      organizationId: input.organizationId,
      recommendationId: input.id,
      evidenceMaxAgeDays: EVIDENCE_MAX_AGE_DAYS,
    });

    if (!state) throw new NotFoundException('Recomendação não encontrada');

    const verdict = revalidatePremise(state);

    if (!verdict.valid) {
      // **Expira na hora, e o motivo fica visível.** Deixar a recomendação viva
      // depois de a premissa vencer é oferecer amanhã a mesma decisão sobre o
      // mesmo mundo que já não existe.
      if (verdict.failure.expiresRecommendation) {
        await this.recommendations.markStatus({
          id: input.id,
          organizationId: input.organizationId,
          status: 'EXPIRED',
          reason: verdict.failure.reason,
        });
      }

      throw new DomainError({
        code: verdict.failure.code,
        category: categoryFor(verdict.failure.code),
        message: verdict.failure.reason,
        details: {
          check: verdict.failure.check,
          expired: verdict.failure.expiresRecommendation,
        },
        remediation: verdict.failure.expiresRecommendation
          ? 'A recomendação foi expirada; o próximo ciclo gera uma nova se o problema persistir.'
          : 'Tente de novo quando a condição que bloqueia a aplicação cessar.',
      });
    }

    return recommendation;
  }

  /** O relatório de dry-run: plano, efeito estimado e a régua do outcome. */
  async execute(input: {
    organizationId: string;
    id: string;
    body: ApplyRecommendationDto;
  }) {
    const recommendation = await this.revalidate({
      organizationId: input.organizationId,
      id: input.id,
    });

    const now = new Date();

    const baseline = await this.outcomes.buildPreWindow({
      organizationId: input.organizationId,
      recommendationId: input.id,
      adId: recommendation.ad.id,
      baseCurrency: recommendation.baseCurrency,
      appliedAt: now,
      windowDays: windowDaysOf(recommendation),
    });

    return envelope(
      {
        recommendationId: input.id,
        dryRun: true,
        premise: { valid: true, checkedAt: now },
        plan: recommendation.actions.map((action) => ({
          actionId: action.id,
          type: action.type,
          level: action.level,
          target: {
            type: action.targetEntityType,
            id: action.targetEntityId,
          },
          parameters: action.parameters,
          scopeWarning: action.scopeWarning,
          reversible: action.reversible,
          requiresRecreate: action.requiresRecreate,
        })),
        estimatedEffect: recommendation.impacts,
        /**
         * O que A2-S7 vai gravar na transação de `appliedAt` (C8). Exposto no
         * dry-run porque o usuário decide contra este número: é a régua com que
         * o impacto será medido depois, e vê-la antes é o que impede a medição
         * de ser uma surpresa.
         */
        outcomeBaseline: baseline
          ? {
              ...baseline,
              observedDeltaKind: PRIMARY_IMPACT_BY_KIND[recommendation.kind],
            }
          : null,
      },
      {
        asOf: now.toISOString(),
        dataMaturity: recommendation.dataMaturity ?? undefined,
        provenance: {
          engineVersion: recommendation.engineVersion,
          windowDays: windowDaysOf(recommendation),
        },
      },
    );
  }
}

/** Janela declarada no impacto — a mesma sobre a qual o outcome vai medir. */
export function windowDaysOf(recommendation: {
  impacts: Array<{ horizonDays: number }>;
}): number {
  return recommendation.impacts.at(0)?.horizonDays ?? 14;
}

/**
 * Cada código tem a categoria que a tela precisa (§7.0.4).
 *
 * *"Não dá para fazer isso"* e *"não dá para fazer isso agora"* pedem telas
 * diferentes, e um 409 genérico não distingue as duas — é por isso que o mapa
 * existe em vez de um `CONFLICT` para tudo.
 */
function categoryFor(code: string) {
  if (code === 'WRITE_IN_FLIGHT') return 'WRITE_IN_FLIGHT' as const;
  if (code === 'INTEGRATION_UNREACHABLE')
    return 'INTEGRATION_UNREACHABLE' as const;
  if (code === 'WRITE_CONSENT_REQUIRED') return 'CONSENT_REQUIRED' as const;
  if (code === 'PLATFORM_ACTIONS_DISABLED') return 'KILL_SWITCH' as const;
  if (code === 'ACTION_UNSUPPORTED') return 'UNSUPPORTED_BY_PLATFORM' as const;
  return 'PRECONDITION_FAILED' as const;
}

export { EVIDENCE_MAX_AGE_DAYS };
