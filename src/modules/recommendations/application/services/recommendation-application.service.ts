import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { WasteItemsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-items.repository';
import { PRIMARY_IMPACT_BY_KIND } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import { RecommendationOutcomesRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { DomainEventBus, emitContext } from 'src/shared/domain/events';
import type { JobContext } from 'src/shared/domain/events/job-context';

export type SettleInput = {
  organizationId: string;
  recommendationId: string;
  /** Todas as execuções reais do plano assentaram como `SUCCEEDED`? */
  allSucceeded: boolean;
  failureDetail: string | null;
  executionIds: string[];
  /** A última a assentar — é ela que resolve os achados vinculados (§9.5.8). */
  lastSettledExecutionId: string | null;
  settledAt: Date;
  actorId: string | null;
  ctx: JobContext;
};

export type SettleResult =
  | { kind: 'APPLIED'; outcomeId: string | null; resolvedWasteItems: number }
  | { kind: 'FAILED' }
  | { kind: 'ALREADY_SETTLED' };

/**
 * Os passos 5, 6, 8 e 9 de §9.5 — o que acontece **depois** de a plataforma
 * responder.
 *
 * Mora em `recommendations` e não em `platform-actions` porque nada aqui é sobre
 * escrita: é sobre o que a recomendação passa a ser quando a escrita termina. A
 * direção do grafo (§5.3 r.5) permite que `platform-actions` chame para cá; a
 * recíproca continua proibida, e é ela que manteria o ciclo aberto.
 *
 * **Idempotente por construção.** A transição parte de `APPLYING` e só dela: um
 * worker reexecutado, um retry de fila ou duas execuções assentando no mesmo
 * milissegundo produzem uma aplicação, um outcome e uma resolução de achados.
 */
@Injectable()
export class RecommendationApplicationService {
  private readonly logger = new Logger(RecommendationApplicationService.name);

  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly outcomes: RecommendationOutcomesRepositoryInterface,
    private readonly wasteItems: WasteItemsRepositoryInterface,
    private readonly events: DomainEventBus,
    private readonly audit: AuditLogService,
  ) {}

  /** §9.5 passo 4 — a recomendação entra em voo antes da primeira escrita. */
  async begin(input: {
    organizationId: string;
    recommendationId: string;
  }): Promise<boolean> {
    return this.recommendations.markApplying({
      id: input.recommendationId,
      organizationId: input.organizationId,
    });
  }

  /**
   * `APPLYING → FAILED` quando nada chegou a ser enfileirado.
   *
   * Sem isto, uma recomendação recusada por guarda depois de entrar em voo
   * ficaria `APPLYING` para sempre — §16.16 proíbe status não terminal sem
   * caminho de saída, e "para sempre" é o pior tipo de saída ausente: a tela
   * mostraria "aplicando…" indefinidamente.
   */
  async abort(input: {
    organizationId: string;
    recommendationId: string;
    reason: string;
  }): Promise<void> {
    await this.recommendations.markApplyFailed({
      id: input.recommendationId,
      organizationId: input.organizationId,
      reason: input.reason,
    });
  }

  async settle(input: SettleInput): Promise<SettleResult> {
    if (!input.allSucceeded) {
      const failed = await this.recommendations.markApplyFailed({
        id: input.recommendationId,
        organizationId: input.organizationId,
        reason:
          input.failureDetail ??
          'Ao menos uma ação do plano não foi aceita pela plataforma.',
      });

      return failed ? { kind: 'FAILED' } : { kind: 'ALREADY_SETTLED' };
    }

    const recommendation = await this.recommendations.findOne(
      input.organizationId,
      input.recommendationId,
    );

    if (!recommendation) return { kind: 'ALREADY_SETTLED' };

    const windowDays = recommendation.impacts.at(0)?.horizonDays ?? 14;

    /**
     * O "pré" é lido **agora**, no instante da aplicação — e é o mais próximo
     * disso que dá para chegar sem mentir. A janela é diária: entre o clique e
     * a resposta da plataforma não há um dia inteiro, então a leitura descreve
     * o mesmo período que descreveria no clique. Adiá-la para o job de medição
     * é que seria diferente: ali ela leria dado já re-declarado (§8.9).
     */
    const baseline = await this.outcomes.buildPreWindow({
      organizationId: input.organizationId,
      recommendationId: input.recommendationId,
      adId: recommendation.ad.id,
      baseCurrency: recommendation.baseCurrency,
      appliedAt: input.settledAt,
      windowDays,
    });

    if (!baseline) {
      await this.recommendations.markApplyFailed({
        id: input.recommendationId,
        organizationId: input.organizationId,
        reason:
          'O anúncio deixou de existir entre a escrita e o registro da aplicação.',
      });
      return { kind: 'FAILED' };
    }

    const { applied, outcomeId } = await this.recommendations.markApplied({
      id: input.recommendationId,
      organizationId: input.organizationId,
      appliedAt: input.settledAt,
      outcome: {
        ...baseline,
        observedDeltaKind: PRIMARY_IMPACT_BY_KIND[recommendation.kind],
        engineVersion: recommendation.engineVersion,
      },
    });

    if (!applied) return { kind: 'ALREADY_SETTLED' };

    const resolvedWasteItems = await this.resolveLinkedFindings({
      organizationId: input.organizationId,
      adId: recommendation.ad.id,
      wasteItemIds: recommendation.wasteItems
        .filter((item) => item.open)
        .map((item) => item.id),
      executionId: input.lastSettledExecutionId,
      settledAt: input.settledAt,
      ctx: input.ctx,
    });

    const emit = emitContext(input.ctx, input.organizationId);

    this.events.emitFrom(emit, 'recommendation.applied', {
      adId: recommendation.ad.id,
      recommendationId: input.recommendationId,
      executionIds: input.executionIds,
    });

    await this.audit.record({
      event: 'ad.recommendation.applied',
      entityType: 'Recommendation',
      entityId: input.recommendationId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      metadata: {
        adId: recommendation.ad.id,
        kind: recommendation.kind,
        // P3 na trilha: a origem é o que separa "a Allva propôs e alguém
        // aceitou" de "alguém digitou". As duas movem dinheiro; só a primeira
        // conta para a acurácia de P8.
        origin: 'RECOMMENDATION',
        executionIds: input.executionIds,
        outcomeId,
        resolvedWasteItems,
      },
    });

    return { kind: 'APPLIED', outcomeId, resolvedWasteItems };
  }

  /**
   * §9.5 passo 8 — resolve **todos** os achados vinculados, não o que originou.
   *
   * Uma recomendação nasce de N achados (o N:N de L4). Pausar o anúncio resolve
   * o CPA alto **e** a fadiga **e** o CTR baixo: fechar um e deixar os outros
   * abertos faria a tela continuar cobrando ação sobre um anúncio que já não
   * veicula.
   *
   * **Fora da transação de `markApplied`, e de propósito.** Os achados são de
   * `waste`, e escrevê-los na mesma transação seria a `recommendations`
   * assumindo o dado de outro módulo. A falha aqui é benigna e tem rede: o
   * auto-resolve do ciclo seguinte (§10.7 passo 7) fecha os itens como
   * `RESOLVED_EXTERNALLY` ao ver a condição cessada. Perde-se a atribuição à
   * ação, não o fechamento.
   */
  private async resolveLinkedFindings(input: {
    organizationId: string;
    adId: string;
    wasteItemIds: string[];
    executionId: string | null;
    settledAt: Date;
    ctx: JobContext;
  }): Promise<number> {
    if (input.wasteItemIds.length === 0) return 0;

    try {
      const resolved = await this.wasteItems.resolveMany(
        input.wasteItemIds.map((id) => ({
          id,
          kind: 'RESOLVED_BY_ACTION' as const,
          resolvedAt: input.settledAt,
          resolvedByActionExecutionId: input.executionId,
        })),
      );

      // O `max` de §10.6 recalculado na hora: sem isto o anúncio ficaria com o
      // `openWasteCount` antigo até a madrugada, exibindo dinheiro queimando
      // num problema que a ação acabou de encerrar.
      await this.wasteItems.recomputeDenormalization(
        [input.adId],
        input.settledAt,
      );

      const emit = emitContext(input.ctx, input.organizationId);
      for (const wasteItemId of input.wasteItemIds) {
        this.events.emitFrom(emit, 'waste.resolved', {
          adId: input.adId,
          wasteItemId,
          resolutionKind: 'RESOLVED_BY_ACTION',
        });
      }

      return resolved;
    } catch (error) {
      this.logger.error(
        `recommendation.waste_resolution_failed recomendação=${input.wasteItemIds.length} itens: ${
          error instanceof Error ? error.message : String(error)
        } — o auto-resolve do ciclo seguinte é a rede`,
      );
      return 0;
    }
  }
}
