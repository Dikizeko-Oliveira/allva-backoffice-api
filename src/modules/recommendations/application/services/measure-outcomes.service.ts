import { Injectable, Logger } from '@nestjs/common';
import {
  MEASUREMENT_VERSION,
  measureOutcome,
} from 'src/modules/recommendations/domain/outcome-measurement';
import {
  RecommendationOutcomesRepositoryInterface,
  type PendingOutcome,
} from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';
import { DomainEventBus, emitContext } from 'src/shared/domain/events';
import type { JobContext } from 'src/shared/domain/events/job-context';

/** Um lote por passada. O job é diário; não precisa esvaziar a fila inteira. */
const BATCH = 200;

/**
 * Depois de quantas janelas sem série uma linha vira `ABANDONED`.
 *
 * Duas: uma janela inteira sem nenhum dia observado já é forte, mas pode ser
 * integração fora do ar. Duas é o ponto em que insistir deixa de ser paciência e
 * vira um denominador que nunca fecha.
 */
const ABANDON_AFTER_WINDOWS = 2;

export type MeasureOutcomesResult = {
  evaluated: number;
  measured: number;
  abandoned: number;
  inconclusive: number;
  /**
   * P8 violado: aplicadas **sem linha de outcome nenhuma**.
   *
   * Diferente de `PENDING_MEASUREMENT`, que é o estado normal de quem espera a
   * janela. Isto é aplicação cujo passo 6 de §9.5 não aconteceu — e o "pré"
   * dela é irrecuperável, porque reconstruí-lo agora leria dado já
   * re-declarado. Zero é o único valor aceitável.
   */
  unmeasurable: string[];
};

/**
 * O job de medição de C4 — **o passo 6 da Definition of Done** (§17.3).
 *
 * > *"Registrar o resultado medido como fato — sem o passo 6, os horizontes H2 e
 * > H3 não têm insumo."*
 *
 * Sem ele a plataforma propõe para sempre sem nunca saber se acertou: o
 * `RecommendationOutcome` nasce em `PENDING_MEASUREMENT` no instante da
 * aplicação e ficaria ali. É o registro que não é adiável (§II.7); a tela é.
 *
 * **A medição é sobre a linhagem, não sobre o `ad_id`** (§3.6). Um
 * `REPLACE_COPY` recria o anúncio; medir por id leria "gasto foi a zero" como
 * sucesso absoluto, quando o gasto só migrou para fora do campo de visão.
 */
@Injectable()
export class MeasureOutcomesService {
  private readonly logger = new Logger(MeasureOutcomesService.name);

  constructor(
    private readonly outcomes: RecommendationOutcomesRepositoryInterface,
    private readonly events: DomainEventBus,
  ) {}

  async execute(input: {
    organizationId: string;
    ctx: JobContext;
    now: Date;
  }): Promise<MeasureOutcomesResult> {
    const pending = await this.outcomes.listPendingMeasurement({
      organizationId: input.organizationId,
      now: input.now,
      limit: BATCH,
    });

    const result: MeasureOutcomesResult = {
      evaluated: pending.length,
      measured: 0,
      abandoned: 0,
      inconclusive: 0,
      unmeasurable: await this.checkP8Invariant(input.organizationId),
    };

    for (const outcome of pending) {
      const measured = await this.measureOne(outcome, input);
      if (measured === 'ABANDONED') result.abandoned += 1;
      else if (measured === 'INCONCLUSIVE') {
        result.measured += 1;
        result.inconclusive += 1;
      } else result.measured += 1;
    }

    return result;
  }

  /**
   * **P8 verificado a cada ciclo, não só em teste.**
   *
   * Uma `APPLIED` sem outcome é um buraco permanente: o "pré" era um fato do
   * instante da aplicação, e reconstruí-lo dias depois leria dado que a
   * plataforma já re-declarou (§8.9). Não há correção — só o registro de que
   * aconteceu, e por isso o log é `error`.
   *
   * A transação de `markApplied` torna isso impossível por construção. O
   * verificador existe porque "impossível por construção" é uma afirmação sobre
   * o código de hoje, e P8 é uma afirmação sobre o dataset de sempre.
   */
  private async checkP8Invariant(organizationId: string): Promise<string[]> {
    const unmeasurable =
      await this.outcomes.findUnmeasuredApplied(organizationId);

    if (unmeasurable.length > 0) {
      this.logger.error(
        `p8.violated organizationId=${organizationId} ` +
          `aplicadas_sem_outcome=${unmeasurable.length} ids=${unmeasurable
            .slice(0, 10)
            .join(',')}`,
      );
    }

    return unmeasurable;
  }

  private async measureOne(
    outcome: PendingOutcome,
    input: { organizationId: string; ctx: JobContext; now: Date },
  ): Promise<'MEASURED' | 'INCONCLUSIVE' | 'ABANDONED'> {
    const post = await this.outcomes.buildPostWindow({
      organizationId: outcome.organizationId,
      lineageId: outcome.lineageId,
      adId: outcome.adId,
      appliedAt: outcome.appliedAt,
      windowDays: outcome.windowDays,
    });

    /**
     * **Zero dias observados não é "gasto zero"** — é cegueira.
     *
     * A distinção é a mesma de §10.7 passo 1 e a razão de `ABANDONED` existir:
     * um anúncio pausado gasta zero *e é observado gastando zero*; um anúncio
     * cuja conta ficou inalcançável não produz linha nenhuma. Tratar os dois
     * igual creditaria à recomendação uma economia integral produzida pela
     * própria falta de dado.
     */
    if (
      post.observedDays === 0 &&
      this.pastAbandonHorizon(outcome, input.now)
    ) {
      await this.outcomes.abandon({
        outcomeId: outcome.id,
        measuredAt: input.now,
        reason:
          'A janela pós não tem nenhum dia observado; a série não permite medir.',
        measurementVersion: MEASUREMENT_VERSION,
      });
      return 'ABANDONED';
    }

    const measurement = measureOutcome({
      kind: outcome.observedDeltaKind,
      windowDays: outcome.windowDays,
      pre: {
        spendBase: outcome.preSpendBase,
        revenueBase: outcome.preRevenueBase,
        conversions: outcome.preConversions,
        aiScore: outcome.preAiScore,
      },
      // M4 — o pós convertido pela **mesma** taxa que o pré, a de `appliedAt`.
      // Sem isto, a variação cambial entre as duas janelas entra no
      // `observedDelta` como se fosse efeito da recomendação.
      post: {
        spendBase: post.spend * outcome.fxRateFixed,
        revenueBase: post.revenue * outcome.fxRateFixed,
        conversions: post.conversions,
        aiScore: post.aiScore,
      },
      observedDays: post.observedDays,
      seriesDiscontinuity: post.seriesDiscontinuity,
      lineageAdCount: post.lineageAdCount,
      externalStatusChange: post.externalStatusChange,
      concurrentActions: post.concurrentActions,
    });

    await this.outcomes.recordMeasurement({
      outcomeId: outcome.id,
      measuredAt: input.now,
      postSpendBase: round4(post.spend * outcome.fxRateFixed),
      postRevenueBase: round4(post.revenue * outcome.fxRateFixed),
      postConversions: post.conversions,
      postAiScore: post.aiScore,
      observedDelta: measurement.observedDelta,
      verdict: measurement.verdict,
      confidence: measurement.confidence,
      confounders: measurement.confounders,
      secondaryDeltas: measurement.secondaryDeltas,
      measurementVersion: MEASUREMENT_VERSION,
    });

    /**
     * O evento sai **mesmo quando o veredito é `INCONCLUSIVE`**. A calibração
     * de P8 precisa saber quantas medições não concluíram tanto quanto precisa
     * das que concluíram: uma taxa de acerto calculada só sobre as conclusivas
     * é uma taxa sobre a amostra que o próprio sistema escolheu.
     */
    this.events.emitFrom(
      emitContext(input.ctx, outcome.organizationId),
      'recommendation.outcome.measured',
      {
        recommendationId: outcome.recommendationId,
        lineageId: outcome.lineageId,
        observedDelta: measurement.observedDelta ?? 0,
        observedDeltaKind: outcome.observedDeltaKind,
        verdict: measurement.verdict,
      },
    );

    this.logger.debug(
      `outcome.measured recomendação=${outcome.recommendationId} ` +
        `veredito=${measurement.verdict} confiança=${measurement.confidence}`,
    );

    return measurement.verdict === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'MEASURED';
  }

  /** `appliedAt + 2 × (janela pós + re-declaração)` — depois disso, desiste. */
  private pastAbandonHorizon(outcome: PendingOutcome, now: Date): boolean {
    const horizon = new Date(outcome.appliedAt);
    horizon.setUTCDate(
      horizon.getUTCDate() +
        ABANDON_AFTER_WINDOWS *
          (outcome.windowDays + Math.max(0, outcome.restatementWindowDays)),
    );

    return now >= horizon;
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
