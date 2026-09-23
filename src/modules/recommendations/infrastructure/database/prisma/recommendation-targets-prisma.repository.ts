import { peerGroupKeyOf } from 'src/modules/ads/domain/ad-unit';
import {
  resolveAdOptimization,
  toOptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { Injectable } from '@nestjs/common';
import {
  AdScoreReader,
  SCORE_FLOORS,
} from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import {
  resolveCandidates,
  type CreativeCandidate,
} from 'src/modules/creative-lab/domain/creative-candidates';
import { sweepableAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import { DEFAULT_DETECTOR_THRESHOLDS } from 'src/modules/waste/domain/detector-profile';
import type { FindingType } from 'src/modules/waste/domain/contracts/finding-catalog';
import { RECOMMENDATION_ENGINE_VERSION } from 'src/modules/recommendations/domain/contracts/engine-version';
import {
  RecommendationTargetsRepositoryInterface,
  type GenerationSettings,
  type ScopeCounts,
} from 'src/modules/recommendations/domain/ports/recommendation-targets.repository';
import type { ActiveSuppression } from 'src/modules/recommendations/domain/suppression';
import type {
  PolicyThresholds,
  RecommendationSignals,
  SelectedCopy,
} from 'src/modules/recommendations/domain/recommendation-plan';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type { RecommendationKind } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import type { SuppressionScope } from 'src/modules/recommendations/domain/suppression';

/**
 * §9.4 passos 1 e 2 — **o único lugar que compõe os três módulos** (§5.3 r.4).
 *
 * `waste` para os achados, `ad-scoring` pelo **port de leitura** (D2) e
 * `creative-lab` para o candidato de substituição. Nenhum deles conhece os
 * outros; é aqui que eles se encontram, e é por isso que este repositório é
 * denso — a densidade está no lugar certo.
 */
const OPTIMIZATION_SELECT = {
  optimizationClass: true,
  conversionEvent: true,
  conversionMeasurable: true,
} as const;

@Injectable()
export class RecommendationTargetsPrismaRepository extends RecommendationTargetsRepositoryInterface {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scores: AdScoreReader,
  ) {
    super();
  }

  async settingsForOrganization(
    organizationId: string,
  ): Promise<GenerationSettings | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: {
        ownerId: true,
        baseCurrency: true,
        currencyState: true,
        adsSettings: { select: { scoringWindowDays: true } },
        // Só contas que o sync ainda lê. A saúde de uma conta desvinculada
        // congela no último valor — quase sempre `HEALTHY` —, e contá-la
        // deixaria a guarda de §9.4 liberar geração sobre dado parado.
        adAccounts: {
          where: sweepableAdAccountWhere(new Date()),
          select: { syncHealth: true },
        },
      },
    });

    if (!organization) return null;

    const windowDays = organization.adsSettings?.scoringWindowDays ?? 14;
    const blockedReason = generationBlockedReason(organization);

    return {
      organizationId,
      accountId: organization.ownerId,
      baseCurrency: organization.baseCurrency,
      windowDays,
      engineVersion: RECOMMENDATION_ENGINE_VERSION,
      thresholds: thresholdsFor(windowDays),
      generationAllowed: blockedReason === null,
      blockedReason,
    };
  }

  async loadSignals(input: {
    organizationId: string;
    baseCurrency: string;
    thresholds: PolicyThresholds;
    now: Date;
  }): Promise<RecommendationSignals[]> {
    // §9.4 passo 2: ads com achado aberto **ou** score fora de faixa. O "ou"
    // importa — `REPLACE_CTA` não nasce de achado nenhum, e um motor que só
    // olhasse a lista de desperdício nunca o produziria.
    const ads = await this.prisma.ad.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: null,
        // Só anúncio de conta que o sync ainda lê: propor pausar ou escalar um
        // anúncio cujo número parou no dia da desconexão é recomendar às cegas.
        adAccount: { is: sweepableAdAccountWhere(input.now) },
        OR: [
          { openWasteCount: { gt: 0 } },
          { wasteItems: { some: { resolvedAt: null } } },
          {
            currentAiScore: { not: null },
            currentScoreConfidence: {
              gte: SCORE_FLOORS.scoreOrdering.minConfidence,
            },
          },
        ],
      },
      select: {
        id: true,
        adSetId: true,
        campaignId: true,
        adAccountId: true,
        platform: true,
        creativeId: true,
        observedStatus: true,
        dataMaturity: true,
        adAccount: { select: { currency: true } },
        creative: { select: { contentHash: true, format: true } },
        adSet: { select: { dailyBudget: true, ...OPTIMIZATION_SELECT } },
        campaign: { select: { dailyBudget: true, ...OPTIMIZATION_SELECT } },
        wasteItems: {
          where: { resolvedAt: null },
          select: {
            id: true,
            type: true,
            findingKind: true,
            priority: true,
            avoidableDailyBase: true,
            avoidableDailyAmount: true,
            incurredAmountBase: true,
            evidenceSufficiency: true,
            dataMaturity: true,
          },
        },
      },
    });

    if (ads.length === 0) return [];

    const scoreByAd = await this.scores.currentByAdIds(
      input.organizationId,
      ads.map((ad) => ad.id),
    );

    const [metrics, adSetFindings, candidates, selectedCopy] =
      await Promise.all([
        this.windowMetrics(
          input.organizationId,
          ads.map((ad) => ad.id),
          input,
        ),
        this.findingsByAdSet(input.organizationId),
        this.candidatesByAccount(input.organizationId),
        this.selectedCopyByAd(
          input.organizationId,
          ads.map((ad) => ad.id),
        ),
      ]);

    const peerRoas = this.peerMedianByGroup(ads, metrics, 'roas');
    const peerCpa = this.peerMedianByGroup(ads, metrics, 'cpa');

    return ads.map((ad) => {
      const window = metrics.get(ad.id);
      const score = scoreByAd.get(ad.id) ?? null;
      const fatigued = ad.creative?.contentHash ?? null;

      // §11.4 — sem candidato, `REFRESH_FATIGUED_CREATIVE` vira consultiva. O
      // resolver é de `creative-lab` e é **função pura**: `recommendations`
      // compõe, não reimplementa.
      const resolution =
        fatigued &&
        ad.wasteItems.some((item) => item.type === 'CREATIVE_FATIGUE')
          ? resolveCandidates({
              fatiguedContentHash: fatigued,
              targetAdSetId: ad.adSetId,
              candidates: candidates.get(ad.adAccountId) ?? [],
              now: input.now,
            })
          : null;

      const best =
        resolution?.kind === 'CANDIDATES' ? resolution.candidates[0] : null;

      return {
        ad: {
          adId: ad.id,
          adSetId: ad.adSetId,
          campaignId: ad.campaignId,
          adAccountId: ad.adAccountId,
          platform: ad.platform,
          creativeId: ad.creativeId,
          creativeFormat: ad.creative?.format ?? null,
          contentHash: fatigued,
          isDelivering:
            ad.observedStatus === 'ACTIVE' ||
            ad.observedStatus === 'PENDING_REVIEW',
          dataMaturity: ad.dataMaturity,
          currency: ad.adAccount.currency,
          // `Ad` não tem relação com `Organization` — só a coluna. A moeda-base
          // vem das settings, que é onde ela é fonte de verdade (R-M).
          baseCurrency: input.baseCurrency,
          frequency: window?.frequency ?? null,
          optimization: resolveAdOptimization(
            ad.adSet ? toOptimizationTarget(ad.adSet) : null,
            toOptimizationTarget(ad.campaign),
          ),
          roas: window?.roas ?? null,
          peerMedianRoas: peerRoas.get(peerGroupKeyOf(ad)) ?? null,
          cpa: window?.cpa ?? null,
          peerMedianCpa: peerCpa.get(peerGroupKeyOf(ad)) ?? null,
          adSetDailyBudget: ad.adSet?.dailyBudget
            ? Number(ad.adSet.dailyBudget)
            : null,
          campaignDailyBudget: ad.campaign.dailyBudget
            ? Number(ad.campaign.dailyBudget)
            : null,
        },
        findings: ad.wasteItems.map((item) => ({
          id: item.id,
          type: item.type as FindingType,
          findingKind: item.findingKind,
          priority: item.priority,
          avoidableDailyBase: Number(item.avoidableDailyBase),
          avoidableDaily: Number(item.avoidableDailyAmount),
          incurredBase: Number(item.incurredAmountBase),
          evidenceSufficiency: item.evidenceSufficiency,
          dataMaturity:
            item.dataMaturity as RecommendationSignals['ad']['dataMaturity'],
        })),
        score: score
          ? {
              aiScore: score.aiScore,
              aiConfidence: score.aiConfidence,
              coverageRatio: score.coverageRatio,
              fatigueScore: score.components.fatigue?.value ?? null,
              learningStability:
                score.components.learningStability?.value ?? null,
              // Só quando o componente entrou no score: o valor nativo é
              // preservado mesmo indisponível, e ler "fit 72" de um anúncio
              // de alcance faria a troca de CTA raciocinar sobre o que não foi
              // medido.
              audienceFit: score.components.audienceFit?.available
                ? score.components.audienceFit.value
                : null,
              negativeFeedbackRisk:
                score.components.negativeFeedbackRisk?.value ?? null,
              delta7d: score.delta7d,
              scoredAt: score.scoredAt,
            }
          : null,
        adSetFindingTypes: ad.adSetId
          ? (adSetFindings.get(ad.adSetId) ?? [])
          : [],
        replacementCreativeId: best?.creativeId ?? null,
        replacementRationale: best?.rationale ?? null,
        /**
         * A variação escolhida no Copy Studio — o que faz `IMPROVE_WEAK_HOOK` e
         * `REPLACE_CTA` deixarem de nascer consultivas por falta de parâmetro.
         *
         * Lido aqui, junto do resto, e não por injeção de `creative-lab`: este
         * repositório já consulta criativos e achados direto, e importar o
         * módulo inteiro para uma leitura acrescentaria uma aresta no grafo
         * para buscar duas colunas.
         */
        selectedCopy: selectedCopy.get(ad.id) ?? null,
        thresholds: input.thresholds,
        now: input.now,
      } satisfies RecommendationSignals;
    });
  }

  /**
   * A variação **escolhida** mais recente de cada anúncio.
   *
   * Escolhida, não gerada: uma geração produz três variações, e três textos não
   * são um parâmetro de ação. A seleção é o ato explícito da pessoa.
   *
   * `aiAuthored` é `true` porque toda variação de `copy_variants` foi escrita
   * por modelo — a tabela existe para isso. Um texto que a pessoa digitou não
   * passa por aqui: ele entra direto no corpo da ação, e o cliente declara a
   * autoria dele.
   */
  private async selectedCopyByAd(
    organizationId: string,
    adIds: string[],
  ): Promise<Map<string, SelectedCopy>> {
    if (adIds.length === 0) return new Map();

    const rows = await this.prisma.copyVariant.findMany({
      where: {
        organizationId,
        selected: true,
        generation: { adId: { in: adIds } },
      },
      orderBy: { selectedAt: 'desc' },
      select: {
        id: true,
        primaryText: true,
        callToAction: true,
        generation: { select: { adId: true } },
      },
    });

    const byAd = new Map<string, SelectedCopy>();

    for (const row of rows) {
      // A ordenação garante que a primeira de cada anúncio é a mais recente.
      if (byAd.has(row.generation.adId)) continue;

      byAd.set(row.generation.adId, {
        variantId: row.id,
        primaryText: row.primaryText,
        callToAction: row.callToAction,
        aiAuthored: true,
      });
    }

    return byAd;
  }

  async scopeCounts(organizationId: string): Promise<ScopeCounts> {
    const [byAdSet, byCampaign] = await Promise.all([
      this.prisma.ad.groupBy({
        by: ['adSetId'],
        where: { organizationId, archivedAt: null },
        _count: { _all: true },
      }),
      this.prisma.ad.groupBy({
        by: ['campaignId'],
        where: { organizationId, archivedAt: null },
        _count: { _all: true },
      }),
    ]);

    return {
      adsByAdSetId: new Map(
        byAdSet
          .filter((row) => row.adSetId !== null)
          .map((row) => [row.adSetId as string, row._count._all]),
      ),
      adsByCampaignId: new Map(
        byCampaign.map((row) => [row.campaignId, row._count._all]),
      ),
    };
  }

  async activeSuppressions(
    organizationId: string,
  ): Promise<ActiveSuppression[]> {
    const rows = await this.prisma.recommendationSuppression.findMany({
      where: { organizationId },
    });

    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as RecommendationKind,
      scope: row.scope as SuppressionScope,
      scopeId: row.scopeId,
      expiresAt: row.expiresAt,
      reason: row.reason,
    }));
  }

  /**
   * Organizações com ao menos uma conta que o sync ainda lê.
   *
   * Gerar sobre conta desvinculada ou com token vencido é propor ação sobre um
   * número que parou no dia da desconexão.
   */
  async listOrganizationsToGenerate(): Promise<string[]> {
    const rows = await this.prisma.organization.findMany({
      where: {
        deletedAt: null,
        adAccounts: { some: sweepableAdAccountWhere(new Date()) },
      },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  async listOrganizationsWithAdAccounts(): Promise<string[]> {
    const rows = await this.prisma.organization.findMany({
      where: { deletedAt: null, adAccounts: { some: {} } },
      select: { id: true },
    });

    return rows.map((row) => row.id);
  }

  /** Agregado da janela por anúncio, em moeda-base (M1). */
  private async windowMetrics(
    organizationId: string,
    adIds: string[],
    input: { now: Date; thresholds: PolicyThresholds },
  ): Promise<
    Map<
      string,
      { roas: number | null; cpa: number | null; frequency: number | null }
    >
  > {
    const since = new Date(input.now);
    since.setUTCDate(since.getUTCDate() - input.thresholds.impactHorizonDays);

    const rows = await this.prisma.adMetricSnapshot.findMany({
      where: {
        organizationId,
        adId: { in: adIds },
        date: { gte: since },
        normalizationPending: false,
      },
      select: {
        adId: true,
        spendBase: true,
        revenueBase: true,
        conversions: true,
        frequency: true,
        impressions: true,
      },
    });

    const totals = new Map<
      string,
      {
        spend: number;
        revenue: number;
        conversions: number;
        weighted: number;
        impressions: number;
      }
    >();

    for (const row of rows) {
      const bucket = totals.get(row.adId) ?? {
        spend: 0,
        revenue: 0,
        conversions: 0,
        weighted: 0,
        impressions: 0,
      };

      bucket.spend += Number(row.spendBase);
      bucket.revenue += Number(row.revenueBase);
      bucket.conversions += row.conversions;
      if (row.frequency !== null) {
        // Frequência ponderada por impressão: a média simples trataria um dia de
        // dez impressões como um dia de cem mil.
        bucket.weighted += row.frequency * row.impressions;
        bucket.impressions += row.impressions;
      }

      totals.set(row.adId, bucket);
    }

    return new Map(
      [...totals.entries()].map(([adId, value]) => [
        adId,
        {
          roas: value.spend > 0 ? value.revenue / value.spend : null,
          cpa: value.conversions > 0 ? value.spend / value.conversions : null,
          frequency:
            value.impressions > 0 ? value.weighted / value.impressions : null,
        },
      ]),
    );
  }

  /**
   * Mediana de uma métrica entre os pares — **mediana, nunca média** (§10.3).
   *
   * ROAS é a régua da escala quando o evento tem valor; CPA, quando não tem.
   * Anúncio sem a métrica (sem conversão na janela) fica fora da amostra, em
   * vez de entrar como zero. Os pares são o conjunto, e a campanha para a
   * unidade sem conjunto — o grupo de recursos (`peerGroupKeyOf`, D23).
   */
  private peerMedianByGroup(
    ads: Array<{ id: string; adSetId: string | null; campaignId: string }>,
    metrics: Map<string, { roas: number | null; cpa: number | null }>,
    metric: 'roas' | 'cpa',
  ): Map<string, number> {
    const byGroup = new Map<string, number[]>();

    for (const ad of ads) {
      const value = metrics.get(ad.id)?.[metric];
      if (value === null || value === undefined) continue;
      const group = peerGroupKeyOf(ad);
      const bucket = byGroup.get(group) ?? [];
      bucket.push(value);
      byGroup.set(group, bucket);
    }

    const medians = new Map<string, number>();
    for (const [group, values] of byGroup) {
      const sorted = [...values].sort((a, b) => a - b);
      const middle = Math.floor(sorted.length / 2);
      medians.set(
        group,
        sorted.length % 2 === 1
          ? sorted[middle]
          : (sorted[middle - 1] + sorted[middle]) / 2,
      );
    }
    return medians;
  }

  /** Achados abertos por conjunto — a guarda de saturação de §9.3. */
  private async findingsByAdSet(
    organizationId: string,
  ): Promise<Map<string, FindingType[]>> {
    const rows = await this.prisma.wasteItem.findMany({
      where: { organizationId, resolvedAt: null },
      select: { type: true, ad: { select: { adSetId: true } } },
    });

    const byAdSet = new Map<string, FindingType[]>();

    for (const row of rows) {
      const adSetId = row.ad.adSetId;
      if (!adSetId) continue;

      const bucket = byAdSet.get(adSetId) ?? [];
      bucket.push(row.type as FindingType);
      byAdSet.set(adSetId, bucket);
    }

    return byAdSet;
  }

  /**
   * Candidatos de substituição por conta (§11.4).
   *
   * **A origem é fechada**: criativos já veiculados na conta. Geração pela Allva
   * é proibida (P1) e a superfície de upload está fora do escopo da v2.0 (D7.1).
   */
  private async candidatesByAccount(organizationId: string) {
    const creatives = await this.prisma.creative.findMany({
      where: { organizationId, archivedAt: null, contentHash: { not: null } },
      select: {
        id: true,
        adAccountId: true,
        contentHash: true,
        name: true,
        externalCreativeId: true,
        thumbnailUrl: true,
        lastSyncedAt: true,
        ads: {
          select: {
            adSetId: true,
            currentAiScore: true,
            lastMetricsSyncAt: true,
          },
        },
      },
    });

    const byAccount = new Map<string, CreativeCandidate[]>();

    for (const creative of creatives) {
      const scored = creative.ads
        .map((ad) => ad.currentAiScore)
        .filter((score): score is number => score !== null);

      if (scored.length === 0) continue;

      const bucket = byAccount.get(creative.adAccountId) ?? [];

      bucket.push({
        creativeId: creative.id,
        contentHash: creative.contentHash as string,
        name: creative.name,
        externalCreativeId: creative.externalCreativeId,
        thumbnailUrl: creative.thumbnailUrl,
        averageScore:
          scored.reduce((sum, score) => sum + score, 0) / scored.length,
        sampleSize: scored.length,
        ranInAdSetIds: creative.ads
          .map((ad) => ad.adSetId)
          .filter((id): id is string => id !== null),
        lastRanAt:
          creative.ads
            .map((ad) => ad.lastMetricsSyncAt)
            .filter((date): date is Date => date !== null)
            .sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
      });

      byAccount.set(creative.adAccountId, bucket);
    }

    return byAccount;
  }
}

/**
 * §9.4 passo 1 — organização com sync válido e **sem recomputo de moeda**.
 *
 * Gerar durante o recomputo produziria um plano cujo valor estimado está numa
 * unidade e metade da base, em outra. E sem nenhuma conta saudável não há
 * observação que sustente plano nenhum.
 */
function generationBlockedReason(organization: {
  currencyState: string;
  adAccounts: Array<{ syncHealth: string }>;
}): string | null {
  if (organization.currencyState === 'RECOMPUTING_CURRENCY') {
    return 'CURRENCY_RECOMPUTING';
  }

  if (organization.adAccounts.length === 0) return 'NO_AD_ACCOUNTS';

  const healthy = organization.adAccounts.some(
    (account) => account.syncHealth === 'HEALTHY',
  );

  return healthy ? null : 'ACCOUNT_UNREACHABLE';
}

/**
 * Os limiares da política, resolvidos a partir do `DetectorProfile` padrão e dos
 * pisos de §12.4.
 *
 * Lê do perfil global em vez de redeclarar: `SCALE_WINNING_AD` bloqueia por
 * frequência com o **mesmo** limiar que `AUDIENCE_SATURATION` usa para disparar,
 * e duas cópias divergiriam na primeira calibração — o produto passaria a
 * escalar exatamente os anúncios que o detector acabou de marcar como saturados.
 */
function thresholdsFor(windowDays: number): PolicyThresholds {
  return {
    scaleMinScore: 75,
    scaleMinConfidence: SCORE_FLOORS.scaleWinningAd.minConfidence,
    scaleMinCoverageRatio: SCORE_FLOORS.scaleWinningAd.minCoverageRatio,
    scaleRoasMultiple: 2,
    scaleMaxFatigue: 0.5,
    saturationFrequency:
      DEFAULT_DETECTOR_THRESHOLDS.AUDIENCE_SATURATION.values.minFrequency,
    minLearningStability:
      DEFAULT_DETECTOR_THRESHOLDS.LEARNING_INSTABILITY.values.maxStability,
    budgetReductionFactor: 0.3,
    scaleIncreaseFactor: 0.2,
    impactHorizonDays: windowDays,
    expiryDays: 7,
  };
}
