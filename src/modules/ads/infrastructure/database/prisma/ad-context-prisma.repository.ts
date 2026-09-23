import { Injectable } from '@nestjs/common';
import {
  AdContextRepositoryInterface,
  AdSetView,
  CampaignView,
  CopyAssetView,
  CreativeView,
  ContextListQuery,
  ContextPage,
} from 'src/modules/ads/domain/ports/ad-context.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AdContextPrismaRepository implements AdContextRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async listCampaigns(
    query: ContextListQuery,
  ): Promise<ContextPage<CampaignView>> {
    const where = {
      organizationId: query.organizationId,
      ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          // A contagem vem do banco por campanha; contar em memória exigiria
          // carregar os anúncios só para descartá-los.
          _count: { select: { ads: { where: { archivedAt: null } } } },
        },
      }),
      this.prisma.campaign.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        externalCampaignId: row.externalCampaignId,
        platform: row.platform,
        name: row.name,
        status: row.status,
        objective: row.objective,
        dailyBudget: row.dailyBudget ? Number(row.dailyBudget) : null,
        lifetimeBudget: row.lifetimeBudget ? Number(row.lifetimeBudget) : null,
        currency: row.currency,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        archivedAt: row.archivedAt,
        activeAdCount: row._count.ads,
      })),
      total,
    };
  }

  async findCampaign(
    organizationId: string,
    campaignId: string,
  ): Promise<CampaignView | null> {
    const row = await this.prisma.campaign.findFirst({
      where: { id: campaignId, organizationId },
      include: {
        _count: { select: { ads: { where: { archivedAt: null } } } },
      },
    });
    if (!row) return null;

    return {
      id: row.id,
      externalCampaignId: row.externalCampaignId,
      platform: row.platform,
      name: row.name,
      status: row.status,
      objective: row.objective,
      dailyBudget: row.dailyBudget ? Number(row.dailyBudget) : null,
      lifetimeBudget: row.lifetimeBudget ? Number(row.lifetimeBudget) : null,
      currency: row.currency,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      archivedAt: row.archivedAt,
      activeAdCount: row._count.ads,
    };
  }

  async listAdSets(query: ContextListQuery): Promise<ContextPage<AdSetView>> {
    const where = {
      organizationId: query.organizationId,
      ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.campaignId ? { campaignId: query.campaignId } : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.adSet.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          _count: { select: { ads: { where: { archivedAt: null } } } },
        },
      }),
      this.prisma.adSet.count({ where }),
    ]);

    return { items: rows.map((row) => this.toAdSet(row)), total };
  }

  async findAdSet(
    organizationId: string,
    adSetId: string,
  ): Promise<AdSetView | null> {
    const row = await this.prisma.adSet.findFirst({
      where: { id: adSetId, organizationId },
      include: { _count: { select: { ads: { where: { archivedAt: null } } } } },
    });

    return row ? this.toAdSet(row) : null;
  }

  /**
   * §7.4 — criativos como contexto (A2-S9).
   *
   * `campaignId` no filtro é resolvido **pelos anúncios**: `Creative` não tem FK
   * de campanha, e não deveria ter — o mesmo criativo roda em campanhas
   * diferentes, e amarrá-lo a uma seria escolher arbitrariamente qual delas o
   * "possui".
   */
  async listCreatives(
    query: ContextListQuery,
  ): Promise<ContextPage<CreativeView>> {
    const where = {
      organizationId: query.organizationId,
      ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
      ...(query.platform ? { platform: query.platform } : {}),
      ...(query.campaignId
        ? { ads: { some: { campaignId: query.campaignId } } }
        : {}),
    };

    const [rows, total] = await Promise.all([
      this.prisma.creative.findMany({
        where,
        // Nome pode ser nulo na plataforma; `id` desempata para a ordenação ser
        // estável entre páginas, que é o que `page`/`limit` pressupõe.
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          _count: { select: { ads: { where: { archivedAt: null } } } },
        },
      }),
      this.prisma.creative.count({ where }),
    ]);

    return { items: rows.map((row) => this.toCreative(row)), total };
  }

  async findCreative(
    organizationId: string,
    creativeId: string,
  ): Promise<CreativeView | null> {
    const row = await this.prisma.creative.findFirst({
      where: { id: creativeId, organizationId },
      include: { _count: { select: { ads: { where: { archivedAt: null } } } } },
    });

    return row ? this.toCreative(row) : null;
  }

  private toCreative(row: {
    id: string;
    externalCreativeId: string;
    platform: CreativeView['platform'];
    name: string | null;
    format: string | null;
    thumbnailUrl: string | null;
    contentHash: string | null;
    durationMs: number | null;
    archivedAt: Date | null;
    lastSyncedAt: Date;
    title: string | null;
    body: string | null;
    callToAction: string | null;
    landingPageUrl: string | null;
    metadata: unknown;
    _count: { ads: number };
  }): CreativeView {
    return {
      id: row.id,
      externalCreativeId: row.externalCreativeId,
      platform: row.platform,
      name: row.name,
      format: row.format,
      thumbnailUrl: row.thumbnailUrl,
      contentHash: row.contentHash,
      durationMs: row.durationMs,
      archivedAt: row.archivedAt,
      lastSyncedAt: row.lastSyncedAt,
      adCount: row._count.ads,
      /**
       * `title` no schema, `headline` no contrato: a plataforma chama de
       * título o campo que o produto e o mercado chamam de headline, e a
       * tradução acontece aqui, na fronteira, em vez de vazar o vocabulário da
       * Meta para dentro da tela.
       */
      copy: {
        headline: row.title,
        body: row.body,
        callToAction: row.callToAction,
        landingPageUrl: row.landingPageUrl,
        assets: copyAssetsOf(row.metadata),
      },
    };
  }

  private toAdSet(row: {
    id: string;
    campaignId: string;
    externalAdSetId: string;
    platform: AdSetView['platform'];
    name: string;
    status: string | null;
    optimizationGoal: string | null;
    billingEvent: string | null;
    dailyBudget: unknown;
    lifetimeBudget: unknown;
    archivedAt: Date | null;
    _count: { ads: number };
  }): AdSetView {
    return {
      id: row.id,
      campaignId: row.campaignId,
      externalAdSetId: row.externalAdSetId,
      platform: row.platform,
      name: row.name,
      status: row.status,
      optimizationGoal: row.optimizationGoal,
      billingEvent: row.billingEvent,
      dailyBudget: row.dailyBudget ? Number(row.dailyBudget) : null,
      lifetimeBudget: row.lifetimeBudget ? Number(row.lifetimeBudget) : null,
      archivedAt: row.archivedAt,
      activeAdCount: row._count.ads,
    };
  }
}

/**
 * Os assets de texto que o ingest guarda em `metadata.copyAssets`.
 *
 * `metadata` é `Json` e vem de fora — do provider, de uma versão anterior do
 * ingest —, então cada item é conferido em vez de confiado: um asset sem texto
 * não entra, porque a tela ofereceria substituir algo que não sabe mostrar.
 */
function copyAssetsOf(metadata: unknown): CreativeView['copy']['assets'] {
  const assets = (metadata as { copyAssets?: unknown } | null)?.copyAssets as
    | { headlines?: unknown; descriptions?: unknown; longHeadlines?: unknown }
    | undefined;

  if (!assets) return null;

  return {
    headlines: assetList(assets.headlines),
    descriptions: assetList(assets.descriptions),
    longHeadlines: assetList(assets.longHeadlines),
  };
}

function assetList(value: unknown): CopyAssetView[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((item: unknown, position): CopyAssetView[] => {
    const asset = item as {
      index?: unknown;
      text?: unknown;
      pinnedField?: unknown;
      performanceLabel?: unknown;
    } | null;

    if (typeof asset?.text !== 'string' || asset.text.length === 0) return [];

    return [
      {
        index: typeof asset.index === 'number' ? asset.index : position,
        text: asset.text,
        pinnedField:
          typeof asset.pinnedField === 'string' ? asset.pinnedField : null,
        performanceLabel:
          typeof asset.performanceLabel === 'string'
            ? asset.performanceLabel
            : null,
      },
    ];
  });
}
