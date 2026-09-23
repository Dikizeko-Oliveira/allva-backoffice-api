import { Injectable } from '@nestjs/common';
import { CurrencyConverterService } from 'src/modules/currency/application/currency-converter.service';
import {
  RecommendationOutcomesRepositoryInterface,
  type MeasurementWrite,
  type PendingOutcome,
  type PostWindowAggregate,
  type PreWindowSnapshot,
} from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';
import type { OutcomeDeltaKind } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import type { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class RecommendationOutcomesPrismaRepository extends RecommendationOutcomesRepositoryInterface {
  constructor(
    private readonly prisma: PrismaService,
    private readonly currency: CurrencyConverterService,
  ) {
    super();
  }

  /**
   * O "pré" lido da série **antes** de qualquer escrita (§9.5 passo 6, C8).
   *
   * A janela é `[appliedAt − windowDays, appliedAt)`, e os dois lados da medição
   * são convertidos pela **mesma** taxa — a de `appliedAt` (M4). É por isso que
   * a soma é feita na moeda nativa e multiplicada depois, em vez de somar
   * `spendBase`: as colunas `*Base` carregam a taxa **do dia de cada linha**, e
   * usá-las faria a variação cambial entre a janela pré e a pós entrar no
   * `observedDelta` como se fosse efeito da recomendação. Numa conta em USD com
   * moeda-base BRL, uma alta de 5% do dólar viraria "a recomendação piorou o
   * gasto em 5%".
   *
   * Linhas com `normalizationPending` continuam de fora: elas entram na série
   * com `spendBase = 0`, e somá-las encolheria o período em silêncio.
   */
  async buildPreWindow(input: {
    organizationId: string;
    recommendationId: string;
    adId: string;
    baseCurrency: string;
    appliedAt: Date;
    windowDays: number;
  }): Promise<Omit<
    PreWindowSnapshot,
    'observedDeltaKind' | 'engineVersion'
  > | null> {
    const ad = await this.prisma.ad.findFirst({
      where: { id: input.adId, organizationId: input.organizationId },
      select: {
        id: true,
        lineageId: true,
        currentAiScore: true,
        adAccount: { select: { currency: true } },
      },
    });

    if (!ad) return null;

    const since = new Date(input.appliedAt);
    since.setUTCDate(since.getUTCDate() - Math.max(1, input.windowDays));

    const rows = await this.prisma.adMetricSnapshot.findMany({
      where: {
        adId: input.adId,
        organizationId: input.organizationId,
        date: { gte: since, lt: input.appliedAt },
        normalizationPending: false,
      },
      select: { spend: true, revenue: true, conversions: true },
    });

    const totals = rows.reduce(
      (sum, row) => ({
        spend: sum.spend + Number(row.spend),
        revenue: sum.revenue + Number(row.revenue),
        conversions: sum.conversions + row.conversions,
      }),
      { spend: 0, revenue: 0, conversions: 0 },
    );

    const fxRateFixed = await this.fixedRate({
      from: ad.adAccount.currency,
      to: input.baseCurrency,
      at: input.appliedAt,
    });

    return {
      recommendationId: input.recommendationId,
      adId: ad.id,
      // A medição segue a **linhagem**: recriar o anúncio não pode ler "gasto
      // foi a zero" como sucesso absoluto quando o gasto só mudou de id (§3.6).
      lineageId: ad.lineageId,
      organizationId: input.organizationId,
      appliedAt: input.appliedAt,
      windowDays: input.windowDays,
      currency: ad.adAccount.currency,
      baseCurrency: input.baseCurrency,
      fxRateFixed,
      preSpendBase: round4(totals.spend * fxRateFixed),
      preRevenueBase: round4(totals.revenue * fxRateFixed),
      preConversions: totals.conversions,
      preAiScore: ad.currentAiScore,
    };
  }

  /**
   * As duas janelas fechadas: a pós e a de re-declaração (§8.9).
   *
   * `restatementWindowDays` é da **conta** (⊕3) e é lido por join em vez de
   * assumido: contas com atribuição de 28 dias reescrevem por 28, e usar um
   * número global mediria metade da base cedo demais.
   */
  async listPendingMeasurement(input: {
    organizationId: string;
    now: Date;
    limit: number;
  }): Promise<PendingOutcome[]> {
    const rows = await this.prisma.recommendationOutcome.findMany({
      where: {
        organizationId: input.organizationId,
        status: 'PENDING_MEASUREMENT',
      },
      orderBy: { appliedAt: 'asc' },
      take: input.limit,
      select: {
        id: true,
        recommendationId: true,
        organizationId: true,
        adId: true,
        lineageId: true,
        appliedAt: true,
        windowDays: true,
        currency: true,
        baseCurrency: true,
        fxRateFixed: true,
        preSpendBase: true,
        preRevenueBase: true,
        preConversions: true,
        preAiScore: true,
        observedDeltaKind: true,
        engineVersion: true,
        recommendation: {
          select: {
            ad: {
              select: {
                adAccount: { select: { restatementWindowDays: true } },
              },
            },
          },
        },
      },
    });

    return rows
      .map((row) => ({
        id: row.id,
        recommendationId: row.recommendationId,
        organizationId: row.organizationId,
        adId: row.adId,
        lineageId: row.lineageId,
        appliedAt: row.appliedAt,
        windowDays: row.windowDays,
        restatementWindowDays:
          row.recommendation.ad.adAccount.restatementWindowDays,
        currency: row.currency,
        baseCurrency: row.baseCurrency,
        fxRateFixed: Number(row.fxRateFixed),
        preSpendBase: Number(row.preSpendBase),
        preRevenueBase: Number(row.preRevenueBase),
        preConversions: row.preConversions,
        preAiScore: row.preAiScore,
        // O kind é declarado na geração (DEC-6). A coluna é nullable por causa
        // do PÓS, não do PRÉ, e o fallback nunca deveria ser exercido — mas um
        // `!` aqui derrubaria o job inteiro por causa de uma linha.
        observedDeltaKind: (row.observedDeltaKind ??
          'SPEND_AVOIDED') as OutcomeDeltaKind,
        engineVersion: row.engineVersion,
      }))
      .filter((row) => measurableAt(row) <= input.now);
  }

  /**
   * A janela pós **sobre a linhagem** (§3.6), não sobre o `ad_id`.
   *
   * Um `REPLACE_COPY` recria o anúncio: o antigo para de gastar e o sucessor
   * assume. Medir por `ad_id` leria "gasto foi a zero" como sucesso absoluto,
   * quando o gasto só migrou para fora do campo de visão — e a recomendação mais
   * cara do catálogo seria a que mais "economiza".
   */
  async buildPostWindow(input: {
    organizationId: string;
    lineageId: string;
    adId: string;
    appliedAt: Date;
    windowDays: number;
  }): Promise<PostWindowAggregate> {
    const until = new Date(input.appliedAt);
    until.setUTCDate(until.getUTCDate() + Math.max(1, input.windowDays));

    const lineageAds = await this.prisma.ad.findMany({
      where: {
        organizationId: input.organizationId,
        lineageId: input.lineageId,
      },
      select: {
        id: true,
        currentAiScore: true,
        observedStatus: true,
        archivedAt: true,
      },
    });

    const adIds = lineageAds.map((ad) => ad.id);

    const [rows, concurrentActions] = await Promise.all([
      this.prisma.adMetricSnapshot.findMany({
        where: {
          adId: { in: adIds },
          organizationId: input.organizationId,
          date: { gte: input.appliedAt, lt: until },
          normalizationPending: false,
        },
        select: {
          adId: true,
          date: true,
          spend: true,
          revenue: true,
          conversions: true,
          seriesDiscontinuity: true,
          syncedAt: true,
        },
        orderBy: { date: 'asc' },
      }),
      /**
       * Outras escritas **nossas** sobre a mesma linhagem dentro da janela.
       *
       * Não é ruído: se o usuário pausou, reativou e trocou o orçamento na
       * mesma semana, o delta medido pertence às três — atribuí-lo à primeira
       * inflaria a acurácia de um kind à custa dos outros.
       */
      this.prisma.actionExecution.count({
        where: {
          organizationId: input.organizationId,
          dryRun: false,
          status: 'SUCCEEDED',
          completedAt: { gt: input.appliedAt, lt: until },
          action: { adId: { in: adIds } },
        },
      }),
    ]);

    const observedDates = new Set<string>();
    const contributingAds = new Set<string>();
    let spend = 0;
    let revenue = 0;
    let conversions = 0;
    let seriesDiscontinuity: string | null = null;
    let lastObservedAt: Date | null = null;

    for (const row of rows) {
      spend += Number(row.spend);
      revenue += Number(row.revenue);
      conversions += row.conversions;
      observedDates.add(row.date.toISOString().slice(0, 10));
      contributingAds.add(row.adId);
      seriesDiscontinuity ??= row.seriesDiscontinuity;
      if (!lastObservedAt || row.syncedAt > lastObservedAt) {
        lastObservedAt = row.syncedAt;
      }
    }

    /**
     * O score do sucessor, quando há um. Ele é quem descreve a mídia que está
     * no ar hoje — o do anúncio substituído congelou no dia em que ele parou.
     */
    const scoringAd =
      lineageAds.find(
        (ad) => contributingAds.has(ad.id) && ad.currentAiScore !== null,
      ) ?? lineageAds.find((ad) => ad.id === input.adId);

    return {
      spend: round4(spend),
      revenue: round4(revenue),
      conversions,
      aiScore: scoringAd?.currentAiScore ?? null,
      observedDays: observedDates.size,
      seriesDiscontinuity,
      lineageAdCount: contributingAds.size,
      externalStatusChange: lineageAds.some(
        (ad) => ad.archivedAt !== null || ad.observedStatus === 'DELETED',
      ),
      concurrentActions,
      lastObservedAt,
    };
  }

  async recordMeasurement(write: MeasurementWrite): Promise<void> {
    await this.prisma.recommendationOutcome.update({
      where: { id: write.outcomeId },
      data: {
        status: 'MEASURED',
        measuredAt: write.measuredAt,
        postSpendBase: write.postSpendBase,
        postRevenueBase: write.postRevenueBase,
        postConversions: write.postConversions,
        postAiScore: write.postAiScore,
        observedDelta: write.observedDelta,
        verdict: write.verdict as never,
        confidence: write.confidence,
        confounders: write.confounders as Prisma.InputJsonValue,
        secondaryDeltas: write.secondaryDeltas as Prisma.InputJsonValue,
        measurementVersion: write.measurementVersion,
      },
    });
  }

  async abandon(input: {
    outcomeId: string;
    measuredAt: Date;
    reason: string;
    measurementVersion: string;
  }): Promise<void> {
    await this.prisma.recommendationOutcome.update({
      where: { id: input.outcomeId },
      data: {
        status: 'ABANDONED',
        measuredAt: input.measuredAt,
        // O veredito fica **nulo**: `INCONCLUSIVE` é resultado de medição, e
        // aqui não houve medição nenhuma. Preenchê-lo faria o abandono entrar
        // nas contagens de P8 como se alguém tivesse olhado.
        confounders: [
          { code: 'ABANDONED', detail: input.reason },
        ] as Prisma.InputJsonValue,
        measurementVersion: input.measurementVersion,
      },
    });
  }

  /**
   * O gate de P8 — `APPLIED` com janela pós completa e sem medição.
   *
   * A janela de re-declaração **não** entra aqui, e a assimetria é deliberada:
   * o job espera por ela para medir bem, mas o gate pergunta o que P8 pergunta —
   * *"toda `APPLIED` com janela pós completa tem outcome persistido?"*. Uma
   * linha `PENDING_MEASUREMENT` é outcome persistido; o que este gate procura
   * são aplicações **sem linha nenhuma**, que é o que o passo 6 de §9.5 impede.
   */
  async findUnmeasuredApplied(organizationId: string): Promise<string[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        organizationId,
        status: 'APPLIED',
        // Consultivas não têm ação e não entram nas métricas de P8 (§9.3).
        advisory: false,
        outcome: null,
      },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  /**
   * A taxa de `appliedAt`, fixada (M4).
   *
   * Passa pelo `currency`, que é o **único** dono de `fx_rates` (§16.10). Taxa
   * ausente cai para 1 e a linha fica na moeda da conta — o `baseCurrency`
   * gravado no outcome diz qual é, e a alternativa (recusar a medição) perderia
   * o histórico por um problema de câmbio.
   */
  private async fixedRate(input: {
    from: string;
    to: string;
    at: Date;
  }): Promise<number> {
    if (input.from === input.to) return 1;

    const converted = await this.currency.normalize({
      amount: 1,
      fromCurrency: input.from,
      toCurrency: input.to,
      date: input.at,
    });

    return converted.normalizationPending ? 1 : converted.valueBase;
  }
}

/** `appliedAt + janela pós + janela de re-declaração` (§8.9). */
function measurableAt(row: {
  appliedAt: Date;
  windowDays: number;
  restatementWindowDays: number;
}): Date {
  const due = new Date(row.appliedAt);
  due.setUTCDate(
    due.getUTCDate() + row.windowDays + Math.max(0, row.restatementWindowDays),
  );
  return due;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
