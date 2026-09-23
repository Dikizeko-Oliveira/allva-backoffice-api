import { peerGroupKeyOf } from 'src/modules/ads/domain/ad-unit';
import { Injectable, Logger } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { calculateAdScore } from 'src/modules/ad-scoring/domain/ad-score-calculation';
import { PRIOR_WEIGHT } from 'src/modules/ad-scoring/domain/composition';
import {
  AdScoreWrite,
  AdScoresRepositoryInterface,
} from 'src/modules/ad-scoring/domain/ports/ad-scores.repository';
import {
  computeInputDigest,
  optimizationKeyOf,
} from 'src/modules/ad-scoring/domain/score-input';
import { hasDiscontinuityBetween } from 'src/modules/ad-scoring/domain/series-continuity';
import { CreativeMetricsAggregator } from 'src/modules/ad-scoring/domain/scoring/creative-metrics-aggregator';
import {
  AdScoringTargetsRepositoryInterface,
  ScorableAd,
} from 'src/modules/ad-scoring/domain/ports/ad-scoring-targets.repository';
import { ScoreEnrichmentService } from 'src/modules/ad-scoring/application/services/score-enrichment.service';
import type { AdScoreNarrativeWrite } from 'src/modules/ad-scoring/domain/ports/ad-scores.repository';
import type { AdNarrativeRequest } from 'src/modules/ad-scoring/domain/ports/ad-narrative.generator';
import type { ScoreComponentName } from 'src/modules/ad-scoring/domain/contracts/score-model';

export type ScoringOutcome = {
  adAccountId: string;
  scored: number;
  /** P9: digest inalterado ⇒ nada recomputa e nenhum LLM é chamado. */
  skippedByDigest: number;
  /** Pausados/arquivados: o último score é preservado com `frozenAt`. */
  frozen: number;
  /** Narrativas de IA efetivamente geradas e anexadas. */
  narrated: number;
  /**
   * Scores que ficaram sem narrativa — plano sem a feature, teto de orçamento
   * ou falha de provider. **Não é erro**: P4 manda o número valer sozinho, e
   * separar do `narrated` é o que torna "a IA não falou" visível sem precisar
   * ler `ai_decision_logs`.
   */
  narrativeSkipped: number;
  /** Preenchido quando §8.7 pausou o scoring — declarado, nunca silencioso. */
  blockedReason: string | null;
};

/**
 * Quantas narrativas em voo ao mesmo tempo.
 *
 * Uma conta de 2 mil anúncios (o teto do plano Profissional) em série seria uma
 * fila de milhares de chamadas de rede numa madrugada; sem limite nenhum seria
 * um lote simultâneo contra o rate limit do provider, que devolveria 429 e
 * transformaria narrativa ausente em regra. Seis é o meio-termo barato: o
 * roteamento já tem fallback para o caso de uma falhar.
 */
const NARRATIVE_CONCURRENCY = 6;

/** Quantos dias atrás o delta compara. */
const DELTA_DAYS = 7;

/**
 * Quantos dias a mais que `DELTA_DAYS` a base do delta pode ter.
 *
 * A busca é "o score mais recente em ou antes de sete dias atrás", e a tolerância
 * existe porque a pontuação não é diária para todo anúncio: com o rodízio da
 * varredura, um anúncio da cauda entra a cada N noites. Três dias absorvem a
 * folga de um núcleo que roda quase todo dia; além disso já não é um delta de
 * sete dias, e chamá-lo assim é o que produzia alerta de queda sobre artefato de
 * escopo em vez de sobre a mídia.
 */
const DELTA_BASELINE_TOLERANCE_DAYS = 3;

/**
 * O scoring de uma conta — o orquestrador de §12.
 *
 * Faz I/O e nada mais: lê a série, chama a função pura, persiste, denormaliza e
 * emite. Toda decisão sobre **o número** está em `domain/`, e é por isso que a
 * composição e a cobertura são testáveis sem container.
 */
@Injectable()
export class ScoreAdAccountService {
  private readonly logger = new Logger(ScoreAdAccountService.name);

  constructor(
    private readonly targets: AdScoringTargetsRepositoryInterface,
    private readonly metrics: AdMetricsRepositoryInterface,
    private readonly scores: AdScoresRepositoryInterface,
    private readonly events: DomainEventBus,
    private readonly enrichment: ScoreEnrichmentService,
  ) {}

  async execute(input: {
    adAccountId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<ScoringOutcome> {
    const now = input.now ?? new Date();
    const settings = await this.targets.settingsForAccount(input.adAccountId);

    if (!settings) {
      throw new Error(`AdAccount ${input.adAccountId} não encontrada`);
    }

    const emit = { ...input.ctx, organizationId: settings.organizationId };

    const outcome: ScoringOutcome = {
      adAccountId: input.adAccountId,
      scored: 0,
      skippedByDigest: 0,
      frozen: 0,
      narrated: 0,
      narrativeSkipped: 0,
      blockedReason: null,
    };

    // §8.7, tabela de degradação: conta `DEGRADED` ou `UNREACHABLE` **pausa o
    // scoring**, e organização em `RECOMPUTING_CURRENCY` também. Pontuar sobre
    // uma leitura que não cobriu a conta produziria queda de score em anúncios
    // que ninguém tocou — o produto reportando o próprio cegueira como fato
    // sobre a mídia do usuário.
    if (!settings.scoringAllowed) {
      outcome.blockedReason = settings.scoringBlockedReason;
      this.logger.warn(
        `ad_scoring.paused adAccountId=${input.adAccountId} motivo=${settings.scoringBlockedReason}`,
      );
      return outcome;
    }

    const ads = await this.targets.listScorable(input.adAccountId);
    if (ads.length === 0) return outcome;

    const window = scoringWindow(now, settings.scoringWindowDays);
    const rows = await this.metrics.query({
      organizationId: settings.organizationId,
      adIds: ads.map((ad) => ad.id),
      since: window.since,
      until: window.until,
    });

    const rowsByAd = groupBy(rows, (row) => row.adId);
    const lastDigests = await this.scores.lastDigestByAd({
      organizationId: settings.organizationId,
      adIds: ads.map((ad) => ad.id),
      algoVersion: settings.activeAlgoVersion,
    });

    // §12.2 — a chegada dos sinais reais **gera descontinuidade**.
    //
    // Quem sabe que ela aconteceu não é a série nem o deploy: é a comparação
    // entre "o último score deste anúncio foi calculado sobre proxy" e "agora
    // existe sinal real". Derivar assim, em vez de usar uma flag de release,
    // funciona por anúncio e por conta — a plataforma libera os sinais quando
    // quer, e não no dia em que subimos o código.
    const wasProxyBased = await this.scores.proxyBasedByAd({
      organizationId: settings.organizationId,
      adIds: ads.map((ad) => ad.id),
      algoVersion: settings.activeAlgoVersion,
    });

    // Benchmarks do ad set: `audienceFit` compara o anúncio com os **pares**,
    // e um CPA só é bom ou ruim contra alguma coisa (§12.2).
    const benchmarksByPeerGroup = this.benchmarksByPeerGroup(rows, ads);

    const writes: AdScoreWrite[] = [];
    const calculations = new Map<string, ReturnType<typeof calculateAdScore>>();

    for (const ad of ads) {
      const adRows = rowsByAd.get(ad.id) ?? [];

      const digest = computeInputDigest({
        rows: adRows,
        algoVersion: settings.activeAlgoVersion,
        priorWeight: PRIOR_WEIGHT,
        windowDays: settings.scoringWindowDays,
        optimizationKey: optimizationKeyOf(ad.optimization),
      });

      // P9. O cron roda todo dia sobre uma janela que quase não muda: sem esta
      // guarda, a mesma série de 14 dias seria recomputada 14 vezes e cada
      // recomputo arrastaria uma chamada de LLM atrás.
      if (lastDigests.get(ad.id) === digest) {
        outcome.skippedByDigest += 1;
        continue;
      }

      const hasRealSignalNow = adRows.some(
        (row) =>
          row.hides !== null ||
          row.hideAllFor !== null ||
          row.reports !== null ||
          row.unlikes !== null,
      );

      const calculation = calculateAdScore({
        platform: ad.platform,
        rows: adRows,
        benchmarks: benchmarksByPeerGroup.get(peerGroupKeyOf(ad)),
        algoVersion: settings.activeAlgoVersion,
        priorWeight: PRIOR_WEIGHT,
        windowDays: settings.scoringWindowDays,
        optimization: ad.optimization,
        // §12.2 — o componente media **outra coisa** até ontem. Comparar o score
        // de hoje com o de anteontem seria comparar réguas diferentes, e é isso
        // que produziria a enxurrada de alertas de queda no dia do deploy.
        newSignalArrived: hasRealSignalNow && wasProxyBased.get(ad.id) === true,
      });

      calculations.set(ad.id, calculation);

      // §12.5: anúncio pausado ou arquivado tem o último score **preservado**,
      // e nenhum alerta de queda é gerado sobre ele. Congelar não é parar de
      // gravar: é declarar que a linha descreve um anúncio que não está
      // entregando, para que ninguém a leia como desempenho recente.
      const frozenAt = ad.isDelivering ? null : now;
      if (frozenAt) outcome.frozen += 1;

      writes.push({
        adId: ad.id,
        organizationId: settings.organizationId,
        creativeId: ad.creativeId,
        scoreDate: utcDay(now),
        windowStart: window.since,
        windowEnd: window.until,
        windowDays: settings.scoringWindowDays,
        algoVersion: settings.activeAlgoVersion,
        priorWeight: PRIOR_WEIGHT,
        aiScore: calculation.aiScore,
        aiConfidence: calculation.aiConfidence,
        componentCoverage: calculation.componentCoverage,
        coverageRatio: calculation.coverageRatio,
        platformCoverageMax: calculation.platformCoverageMax,
        components: calculation.components,
        context: calculation.context,
        seriesDiscontinuity: calculation.seriesDiscontinuity,
        frozenAt,
        inputDigest: digest,
      });
    }

    if (writes.length === 0) return outcome;

    const idsByAd = await this.scores.appendMany(writes);
    outcome.scored = writes.length;

    const deltas = await this.computeDeltas({
      organizationId: settings.organizationId,
      algoVersion: settings.activeAlgoVersion,
      ads,
      rowsByAd,
      calculations,
      now,
    });

    await this.scores.denormalizeIntoAds(
      writes
        .filter((write) => idsByAd.has(write.adId))
        .map((write) => ({
          adId: write.adId,
          currentScoreId: idsByAd.get(write.adId) as string,
          currentAiScore: write.aiScore,
          currentScoreConfidence: write.aiConfidence,
          // **`coverageRatio`**, não a cobertura absoluta: é sobre a razão que os
          // pisos de §12.4 incidem, e a coluna existe para eles serem aplicáveis
          // em `WHERE` (DEC-2).
          currentScoreCoverage: write.coverageRatio,
          scoreDelta7d: deltas.get(write.adId) ?? null,
          scoreAsOf: now,
        })),
    );

    for (const write of writes) {
      this.events.emitFrom(emit, 'ad.scored', {
        adId: write.adId,
        adScoreId: idsByAd.get(write.adId) ?? '',
        aiScore: write.aiScore,
        delta7d: deltas.get(write.adId) ?? null,
        algoVersion: write.algoVersion,
      });
    }

    /**
     * §12.6 — a narrativa entra **por último**, depois de o score estar
     * persistido, denormalizado e emitido.
     *
     * A posição é a regra P4 escrita como ordem de execução: até esta linha o
     * ciclo está completo e correto sem uma única chamada de LLM. O que vier
     * daqui para baixo só pode acrescentar um texto — `ScoreEnrichmentService`
     * nunca lança, e o pior desfecho possível é uma narrativa nula.
     *
     * O conjunto é `writes`, e não `ads`: quem não passou pela guarda de digest
     * já tem narrativa da rodada anterior, e regerá-la pagaria de novo por um
     * texto que descreveria os mesmos números. É a economia que o comentário de
     * P9 lá em cima antecipa quando fala em "arrastar uma chamada de LLM atrás".
     */
    await this.narrate({
      writes,
      idsByAd,
      adsById: new Map(ads.map((ad) => [ad.id, ad])),
      organizationId: settings.organizationId,
      correlationId: input.ctx.correlationId ?? null,
      outcome,
      now,
    });

    this.logger.log(
      `ad.scored adAccountId=${input.adAccountId} pontuados=${outcome.scored} ` +
        `pulados_por_digest=${outcome.skippedByDigest} congelados=${outcome.frozen} ` +
        `narrados=${outcome.narrated} sem_narrativa=${outcome.narrativeSkipped}`,
    );

    return outcome;
  }

  /** Gera e anexa as narrativas dos scores recém-gravados. */
  private async narrate(input: {
    writes: AdScoreWrite[];
    idsByAd: Map<string, string>;
    adsById: Map<string, ScorableAd>;
    organizationId: string;
    correlationId: string | null;
    outcome: ScoringOutcome;
    now: Date;
  }): Promise<void> {
    const pending = input.writes.filter((write) =>
      input.idsByAd.has(write.adId),
    );
    if (pending.length === 0) return;

    const narratives: AdScoreNarrativeWrite[] = [];
    let cursor = 0;

    // Um pool de tamanho fixo: cada worker puxa o próximo índice até a fila
    // acabar. `Promise.all` sobre o lote inteiro dispararia tudo de uma vez.
    const worker = async (): Promise<void> => {
      while (cursor < pending.length) {
        const write = pending[cursor];
        cursor += 1;

        const ad = input.adsById.get(write.adId);
        if (!ad) continue;

        const result = await this.enrichment.enrich({
          organizationId: input.organizationId,
          adId: write.adId,
          request: toNarrativeRequest(ad, write),
          inputDigest: write.inputDigest,
          correlationId: input.correlationId,
          now: input.now,
        });

        if (result.narrative === null) {
          input.outcome.narrativeSkipped += 1;
          continue;
        }

        narratives.push({
          scoreId: input.idsByAd.get(write.adId) as string,
          narrative: result.narrative,
          provider: result.provider ?? 'unknown',
          model: result.model ?? 'unknown',
        });
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(NARRATIVE_CONCURRENCY, pending.length) },
        () => worker(),
      ),
    );

    await this.scores.attachNarratives(narratives);
    input.outcome.narrated = narratives.length;
  }

  /**
   * O delta de 7 dias — **e o gate do sprint**.
   *
   * `null` quando há descontinuidade entre as duas pontas: comparar através dela
   * é comparar réguas diferentes, e é assim que o dia do deploy de um sinal novo
   * produziria uma enxurrada de alertas de queda sobre um fato que é do release.
   * O alerta `AD_SCORE_DROPPED` (A2-S5) lê este campo: `null` significa "não há
   * delta a alertar", não "delta zero".
   */
  private async computeDeltas(input: {
    organizationId: string;
    algoVersion: string;
    ads: ScorableAd[];
    rowsByAd: Map<string, AdMetricSnapshotRow[]>;
    calculations: Map<string, ReturnType<typeof calculateAdScore>>;
    now: Date;
  }): Promise<Map<string, number>> {
    const reference = new Date(input.now);
    reference.setUTCDate(reference.getUTCDate() - DELTA_DAYS);

    const floor = new Date(reference);
    floor.setUTCDate(floor.getUTCDate() - DELTA_BASELINE_TOLERANCE_DAYS);

    const previous = await this.scores.scoreAtOrBefore({
      organizationId: input.organizationId,
      lineageIds: [...new Set(input.ads.map((ad) => ad.lineageId))],
      date: utcDay(reference),
      // Sem este piso, um anúncio que só volta ao escopo a cada onze noites
      // teria "delta de 7 dias" calculado sobre onze — e o alerta de queda
      // descreveria o rodízio, não a mídia.
      notBefore: utcDay(floor),
      algoVersion: input.algoVersion,
    });

    const deltas = new Map<string, number>();

    for (const ad of input.ads) {
      const calculation = input.calculations.get(ad.id);
      const before = previous.get(ad.lineageId);
      if (!calculation || !before) continue;

      const cutsThrough = hasDiscontinuityBetween(
        input.rowsByAd.get(ad.id) ?? [],
        before.scoreDate,
        utcDay(input.now),
      );

      if (cutsThrough) continue;

      deltas.set(
        ad.id,
        Math.round((calculation.aiScore - before.aiScore) * 100) / 100,
      );
    }

    return deltas;
  }

  /**
   * As medianas dos pares: o conjunto, e a campanha para a unidade sem conjunto
   * (`peerGroupKeyOf`, D23). Sem isso o grupo de recursos pontuava sem
   * referência nenhuma.
   */
  private benchmarksByPeerGroup(
    rows: AdMetricSnapshotRow[],
    ads: ScorableAd[],
  ): Map<string, ReturnType<typeof CreativeMetricsAggregator.benchmarks>> {
    const groupByAd = new Map(ads.map((ad) => [ad.id, peerGroupKeyOf(ad)]));
    const byGroup = groupBy(rows, (row) => groupByAd.get(row.adId) ?? '');

    const benchmarks = new Map<
      string,
      ReturnType<typeof CreativeMetricsAggregator.benchmarks>
    >();

    for (const [group, groupRows] of byGroup) {
      if (!group) continue;
      benchmarks.set(group, CreativeMetricsAggregator.benchmarks(groupRows));
    }

    return benchmarks;
  }
}

function scoringWindow(now: Date, days: number): { since: Date; until: Date } {
  const until = utcDay(now);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - Math.max(1, days) + 1);
  return { since, until };
}

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item)) ?? [];
    bucket.push(item);
    grouped.set(key(item), bucket);
  }
  return grouped;
}

/**
 * O score persistido, traduzido no que o prompt precisa saber.
 *
 * **Os componentes indisponíveis vão junto, com o motivo.** É o ponto inteiro
 * do contrato por assunto: sem a ausência declarada, o modelo preenche a lacuna
 * — ele é bom nisso — e o produto passa a afirmar sobre fadiga criativa numa
 * conta onde nenhuma plataforma expôs o dado. P7 exige a ausência declarada, e
 * a única forma de o modelo respeitá-la é ela estar no prompt.
 */
function toNarrativeRequest(
  ad: ScorableAd,
  write: AdScoreWrite,
): AdNarrativeRequest {
  const entries = Object.entries(write.components) as Array<
    [ScoreComponentName, (typeof write.components)[ScoreComponentName]]
  >;

  const unavailableReasons: Partial<Record<ScoreComponentName, string>> = {};
  for (const [name, component] of entries) {
    if (!component.available && component.unavailableReason) {
      unavailableReasons[name] = component.unavailableReason;
    }
  }

  return {
    adName: ad.name,
    platform: ad.platform,
    aiScore: write.aiScore,
    aiConfidence: write.aiConfidence,
    coverageRatio: write.coverageRatio,
    components: entries.map(([name, component]) => ({
      name,
      value: component.value,
      available: component.available,
      reasons: component.reasons,
    })),
    unavailableReasons,
    windowDays: write.windowDays,
  };
}
