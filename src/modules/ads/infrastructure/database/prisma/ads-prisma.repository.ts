import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import {
  AD_SORT_SPECS,
  floorForQuery,
} from 'src/modules/ads/domain/ad-list-sorting';
import {
  AdHistoryEntry,
  AdListQuery,
  AdListResult,
  AdSeriesQuery,
  AdsRepositoryInterface,
} from 'src/modules/ads/domain/ports/ads.repository';
import {
  AdDetailView,
  AdListItemView,
  AdRef,
  AdSnapshotView,
} from 'src/modules/ads/domain/read-models/ad-views';
import { asDiscontinuityReason } from 'src/modules/ads/domain/series-discontinuity';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { moneyView } from 'src/shared/infrastructure/http/envelope/money-view';

/** O que a listagem seleciona — nada além do que a linha da tela usa. */
const LIST_SELECT = {
  id: true,
  lineageId: true,
  name: true,
  platform: true,
  externalAdId: true,
  unitKind: true,
  observedStatus: true,
  desiredStatus: true,
  syncState: true,
  dataMaturity: true,
  currentAiScore: true,
  currentScoreConfidence: true,
  currentScoreCoverage: true,
  scoreDelta7d: true,
  scoreAsOf: true,
  openWasteCount: true,
  openWasteAmount: true,
  openWasteCurrency: true,
  openWasteAmountBase: true,
  avoidableDailyAmountBase: true,
  wasteAsOf: true,
  archivedAt: true,
  campaign: { select: { id: true, name: true } },
  adSet: { select: { id: true, name: true } },
  creative: { select: { id: true, thumbnailUrl: true, format: true } },
} satisfies Prisma.AdSelect;

type ListRow = Prisma.AdGetPayload<{ select: typeof LIST_SELECT }>;

@Injectable()
export class AdsPrismaRepository implements AdsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AdListQuery): Promise<AdListResult> {
    const spec = AD_SORT_SPECS[query.sortBy];
    const floor = floorForQuery(query);
    const where = this.toWhere(query, floor);

    // Uma linha a mais que o limite: é assim que se sabe que há próxima página
    // sem um COUNT(*), que na tabela de anúncios de uma conta grande custa mais
    // que a própria consulta.
    const rows = await this.prisma.ad.findMany({
      where,
      select: LIST_SELECT,
      orderBy: [
        { [spec.column]: query.sortDirection },
        // `id` é o desempate estável do cursor: sem ele, duas linhas com o mesmo
        // score trocam de ordem entre páginas e uma some.
        { id: query.sortDirection },
      ],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor.id }, skip: 1 } : {}),
    });

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map((row) =>
      this.toListItem(row),
    );

    return {
      items,
      hasMore,
      // §12.4 manda declarar quantos ficaram fora da ordenação por confiança.
      // Sem o número, lista curta é indistinguível de conta saudável.
      excludedByFloor: floor
        ? await this.prisma.ad.count({
            where: {
              ...this.toWhere(query, null),
              OR: [
                { currentScoreConfidence: { lt: floor.minConfidence } },
                { currentScoreCoverage: { lt: floor.minCoverageRatio } },
                { currentAiScore: null },
              ],
            },
          })
        : 0,
    };
  }

  async findDetail(
    organizationId: string,
    adId: string,
  ): Promise<AdDetailView | null> {
    const row = await this.prisma.ad.findFirst({
      where: { id: adId, organizationId },
      select: {
        ...LIST_SELECT,
        accountId: true,
        organizationId: true,
        adAccountId: true,
        observedAsOf: true,
        desiredStatusSetAt: true,
        syncStateAt: true,
        lastStructureSyncAt: true,
        lastMetricsSyncAt: true,
        firstSeenAt: true,
        originAdId: true,
        originActionExecutionId: true,
      },
    });

    if (!row) return null;

    const generations = await this.prisma.ad.count({
      where: { organizationId, lineageId: row.lineageId },
    });

    return {
      ...this.toListItem(row),
      accountId: row.accountId,
      organizationId: row.organizationId,
      adAccountId: row.adAccountId,
      observedAsOf: row.observedAsOf,
      desiredStatusSetAt: row.desiredStatusSetAt,
      syncStateAt: row.syncStateAt,
      lastStructureSyncAt: row.lastStructureSyncAt,
      lastMetricsSyncAt: row.lastMetricsSyncAt,
      firstSeenAt: row.firstSeenAt,
      lineage: {
        lineageId: row.lineageId,
        originAdId: row.originAdId,
        originActionExecutionId: row.originActionExecutionId,
        generations,
      },
    };
  }

  async findRef(organizationId: string, adId: string): Promise<AdRef | null> {
    const row = await this.prisma.ad.findFirst({
      where: { id: adId, organizationId },
      select: LIST_SELECT,
    });

    return row ? this.toRef(row) : null;
  }

  async series(query: AdSeriesQuery): Promise<AdSnapshotView[]> {
    const adIds = await this.resolveSeriesAdIds(query);

    const rows = await this.prisma.adMetricSnapshot.findMany({
      where: {
        organizationId: query.organizationId,
        adId: { in: adIds },
        date: { gte: query.since, lte: query.until },
      },
      orderBy: { date: 'asc' },
    });

    return rows.map((row) => {
      const spend = Number(row.spend);
      const revenue = Number(row.revenue);

      return {
        adId: row.adId,
        date: row.date,
        spend: moneyView({
          value: spend,
          currency: row.currency,
          valueBase: Number(row.spendBase),
          baseCurrency: row.baseCurrency,
          fxRate: row.fxRate ? Number(row.fxRate) : null,
          fxAsOf: row.fxAsOf,
        }),
        revenue: moneyView({
          value: revenue,
          currency: row.currency,
          valueBase: Number(row.revenueBase),
          baseCurrency: row.baseCurrency,
          fxRate: row.fxRate ? Number(row.fxRate) : null,
          fxAsOf: row.fxAsOf,
        }),
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        // Ratios derivados na leitura, nunca armazenados: persistidos, eles
        // divergem da base assim que duas linhas são agregadas.
        ctr: row.impressions > 0 ? (row.clicks / row.impressions) * 100 : null,
        cpc: row.clicks > 0 ? spend / row.clicks : null,
        cpa: row.conversions > 0 ? spend / row.conversions : null,
        roas: spend > 0 ? revenue / spend : null,
        frequency: row.frequency,
        // Recusa valor fora do vocabulário de §12.5: a coluna é TEXT e nada no
        // banco impede uma string qualquer, mas o read model promete um motivo.
        seriesDiscontinuity: asDiscontinuityReason(row.seriesDiscontinuity),
        normalizationPending: row.normalizationPending,
      };
    });
  }

  async history(
    organizationId: string,
    adId: string,
    followLineage: boolean,
  ): Promise<AdHistoryEntry[]> {
    const ads = await this.prisma.ad.findMany({
      where: followLineage
        ? {
            organizationId,
            lineageId: (
              await this.prisma.ad.findFirstOrThrow({
                where: { id: adId, organizationId },
                select: { lineageId: true },
              })
            ).lineageId,
          }
        : { id: adId, organizationId },
      select: {
        id: true,
        name: true,
        firstSeenAt: true,
        archivedAt: true,
        originAdId: true,
        lastStructureSyncAt: true,
      },
      orderBy: { firstSeenAt: 'asc' },
    });

    const entries: AdHistoryEntry[] = [];
    for (const ad of ads) {
      entries.push({
        at: ad.firstSeenAt,
        kind: ad.originAdId ? 'DERIVED' : 'DISCOVERED',
        summary: ad.originAdId
          ? `"${ad.name}" derivado de um anúncio anterior da mesma linhagem`
          : `"${ad.name}" descoberto na plataforma`,
        details: ad.originAdId ? { originAdId: ad.originAdId } : null,
      });

      if (ad.archivedAt) {
        entries.push({
          at: ad.archivedAt,
          kind: 'ARCHIVED',
          summary: `"${ad.name}" arquivado`,
          details: null,
        });
      }
    }

    return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
  }

  async lineageMembers(
    organizationId: string,
    lineageId: string,
  ): Promise<AdRef[]> {
    const rows = await this.prisma.ad.findMany({
      where: { organizationId, lineageId },
      select: LIST_SELECT,
      orderBy: { firstSeenAt: 'asc' },
    });

    return rows.map((row) => this.toRef(row));
  }

  /**
   * A série segue a **linhagem** por padrão (§7.1): recriar o anúncio é evento
   * nosso, não do usuário, e a série que ele espera é a da intenção
   * publicitária — não a do id que a plataforma trocou.
   */
  private async resolveSeriesAdIds(query: AdSeriesQuery): Promise<string[]> {
    if (!query.followLineage) return [query.adId];

    const ad = await this.prisma.ad.findFirst({
      where: { id: query.adId, organizationId: query.organizationId },
      select: { lineageId: true },
    });
    if (!ad) return [query.adId];

    const members = await this.prisma.ad.findMany({
      where: { organizationId: query.organizationId, lineageId: ad.lineageId },
      select: { id: true },
    });

    return members.map((member) => member.id);
  }

  /**
   * **Toda consulta filtra `organizationId`** (§16.7). É o primeiro campo do
   * `where` de propósito: um filtro de tenancy que é fácil de esquecer no fim de
   * uma lista de dezesseis é um vazamento esperando acontecer.
   */
  private toWhere(
    query: AdListQuery,
    floor: { minConfidence: number; minCoverageRatio: number } | null,
  ): Prisma.AdWhereInput {
    return {
      organizationId: query.organizationId,
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
      ...(query.adSetId ? { adSetId: query.adSetId } : {}),
      ...(query.creativeId ? { creativeId: query.creativeId } : {}),
      ...(query.status ? { observedStatus: query.status } : {}),
      ...(query.syncState ? { syncState: query.syncState } : {}),
      ...(query.lineageId ? { lineageId: query.lineageId } : {}),
      ...(query.dataMaturity ? { dataMaturity: query.dataMaturity } : {}),
      // Arquivado fica fora por padrão: a tela existe para o que ainda gasta.
      ...(query.archived === undefined
        ? { archivedAt: null }
        : query.archived
          ? { archivedAt: { not: null } }
          : { archivedAt: null }),
      ...(query.hasOpenWaste ? { openWasteCount: { gt: 0 } } : {}),
      ...(query.hasOpenOpportunity
        ? {
            wasteItems: {
              some: { findingKind: 'OPPORTUNITY', status: 'OPEN' },
            },
          }
        : {}),
      ...(query.minWasteAmountBase !== undefined
        ? { openWasteAmountBase: { gte: query.minWasteAmountBase } }
        : {}),
      ...(query.scoreBelow !== undefined
        ? { currentAiScore: { lt: query.scoreBelow } }
        : {}),
      ...(query.scoreDroppedBy !== undefined
        ? { scoreDelta7d: { lte: -Math.abs(query.scoreDroppedBy) } }
        : {}),
      ...(query.confidenceAbove !== undefined
        ? { currentScoreConfidence: { gte: query.confidenceAbove } }
        : {}),
      // O piso de §12.4 entra como `WHERE`, não como filtro em memória: é para
      // isso que confiança e cobertura são denormalizadas em `ads`.
      ...(floor
        ? {
            currentScoreConfidence: { gte: floor.minConfidence },
            currentScoreCoverage: { gte: floor.minCoverageRatio },
          }
        : {}),
    };
  }

  private toRef(row: ListRow): AdRef {
    return {
      id: row.id,
      lineageId: row.lineageId,
      name: row.name,
      platform: row.platform,
      externalAdId: row.externalAdId,
      unitKind: row.unitKind,
      observedStatus: row.observedStatus,
      desiredStatus: row.desiredStatus,
      syncState: row.syncState,
      campaign: { id: row.campaign.id, name: row.campaign.name },
      adSet: row.adSet ? { id: row.adSet.id, name: row.adSet.name } : null,
      creative: row.creative
        ? {
            id: row.creative.id,
            thumbnailUrl: row.creative.thumbnailUrl,
            format: row.creative.format,
          }
        : null,
    };
  }

  private toListItem(row: ListRow): AdListItemView {
    const currency = row.openWasteCurrency;
    const baseCurrency = 'BRL';

    return {
      ...this.toRef(row),
      dataMaturity: row.dataMaturity,
      score: {
        value: row.currentAiScore,
        confidence: row.currentScoreConfidence,
        coverage: row.currentScoreCoverage,
        delta7d: row.scoreDelta7d,
        asOf: row.scoreAsOf,
      },
      waste: {
        openCount: row.openWasteCount,
        openAmount: currency
          ? moneyView({
              value: Number(row.openWasteAmount),
              currency,
              valueBase: Number(row.openWasteAmountBase),
              baseCurrency,
            })
          : null,
        avoidableDaily: currency
          ? moneyView({
              value: Number(row.avoidableDailyAmountBase),
              currency: baseCurrency,
              valueBase: Number(row.avoidableDailyAmountBase),
              baseCurrency,
            })
          : null,
        asOf: row.wasteAsOf,
      },
      archivedAt: row.archivedAt,
    };
  }
}
