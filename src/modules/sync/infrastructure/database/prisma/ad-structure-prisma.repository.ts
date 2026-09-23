import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import { deriveLineage, startLineage } from 'src/modules/ads/domain/ad-lineage';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import {
  AdStructureRepositoryInterface,
  AdSyncSnapshot,
  UpsertAdInput,
  UpsertAdSetInput,
  UpsertCampaignInput,
  UpsertCreativeInput,
  UpsertedAd,
} from 'src/modules/sync/domain/ports/ad-structure.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import type { OptimizationTarget } from 'src/modules/integrations/domain/entities/optimization-target';

const AD_SELECT = {
  id: true,
  organizationId: true,
  adAccountId: true,
  externalAdId: true,
  lineageId: true,
  observedStatus: true,
  observedAsOf: true,
  desiredStatus: true,
  desiredStatusSetAt: true,
  syncState: true,
  driftDetails: true,
  lastMetricsSyncAt: true,
  lastStructureSyncAt: true,
  archivedAt: true,
} as const;

/**
 * As três colunas do objetivo traduzido — ou nenhuma.
 *
 * `undefined` não escreve nada: o provider não leu, e o valor gravado continua
 * valendo. `null` também não apaga: "não sei" nunca sobrescreve "sei".
 */
function optimizationColumns(target: OptimizationTarget | null | undefined) {
  if (!target) return {};
  return {
    optimizationClass: target.optimizationClass,
    conversionEvent: target.conversionEvent,
    conversionMeasurable: target.conversionMeasurable,
  };
}

@Injectable()
export class AdStructurePrismaRepository extends AdStructureRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async upsertCampaign(input: UpsertCampaignInput): Promise<string> {
    const row = await this.prisma.campaign.upsert({
      where: {
        adAccountId_externalCampaignId: {
          adAccountId: input.adAccountId,
          externalCampaignId: input.externalCampaignId,
        },
      },
      create: {
        adAccountId: input.adAccountId,
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        platform: input.platform,
        externalCampaignId: input.externalCampaignId,
        name: input.name,
        status: input.status,
        objective: input.objective,
        ...optimizationColumns(input.optimization),
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        currency: input.currency,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        metadata: toPrismaJson(input.metadata ?? undefined),
      },
      update: {
        // `integrationId` acompanha a credencial corrente (P10): a identidade é
        // `(adAccountId, externalCampaignId)` e não muda com o rebind.
        integrationId: input.integrationId,
        name: input.name,
        status: input.status,
        objective: input.objective,
        ...optimizationColumns(input.optimization),
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        currency: input.currency,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        lastSyncedAt: new Date(),
      },
      select: { id: true },
    });

    return row.id;
  }

  async upsertAdSet(input: UpsertAdSetInput): Promise<string> {
    const row = await this.prisma.adSet.upsert({
      where: {
        adAccountId_externalAdSetId: {
          adAccountId: input.adAccountId,
          externalAdSetId: input.externalAdSetId,
        },
      },
      create: {
        adAccountId: input.adAccountId,
        organizationId: input.organizationId,
        campaignId: input.campaignId,
        platform: input.platform,
        externalAdSetId: input.externalAdSetId,
        name: input.name,
        status: input.status,
        optimizationGoal: input.optimizationGoal,
        billingEvent: input.billingEvent,
        ...optimizationColumns(input.optimization),
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        targeting: toPrismaJson(input.targeting ?? undefined),
      },
      update: {
        campaignId: input.campaignId,
        name: input.name,
        status: input.status,
        optimizationGoal: input.optimizationGoal,
        billingEvent: input.billingEvent,
        ...optimizationColumns(input.optimization),
        dailyBudget: input.dailyBudget,
        lifetimeBudget: input.lifetimeBudget,
        targeting: toPrismaJson(input.targeting ?? undefined),
      },
      select: { id: true },
    });

    return row.id;
  }

  async upsertCreative(input: UpsertCreativeInput): Promise<string> {
    const row = await this.prisma.creative.upsert({
      where: {
        adAccountId_externalCreativeId: {
          adAccountId: input.adAccountId,
          externalCreativeId: input.externalCreativeId,
        },
      },
      create: {
        adAccountId: input.adAccountId,
        organizationId: input.organizationId,
        platform: input.platform,
        externalCreativeId: input.externalCreativeId,
        name: input.name,
        title: input.title,
        body: input.body,
        callToAction: input.callToAction,
        format: input.format,
        thumbnailUrl: input.thumbnailUrl,
        videoUrl: input.videoUrl,
        imageUrl: input.imageUrl,
        landingPageUrl: input.landingPageUrl,
        contentHash: input.contentHash,
        metadata: toPrismaJson(input.metadata ?? undefined),
      },
      update: {
        name: input.name,
        title: input.title,
        body: input.body,
        callToAction: input.callToAction,
        format: input.format,
        // `null` do provider não apaga (D7). Google não manda thumbnail para
        // anúncio de vídeo e o TikTok manda por chamada à parte — as duas
        // plataformas voltam `null` sempre que a resolução falha ou o campo
        // não existe naquele formato, e o sync diário sobrescreveria em
        // silêncio a miniatura que o backfill de ffmpeg gerou. Um valor novo
        // de verdade sempre sobrescreve: só a ausência é que não conta como
        // fato sobre o criativo.
        thumbnailUrl: input.thumbnailUrl ?? undefined,
        videoUrl: input.videoUrl,
        imageUrl: input.imageUrl,
        landingPageUrl: input.landingPageUrl,
        contentHash: input.contentHash,
        // Sem isto, o metadata só nascia na criação: um criativo já existente
        // nunca recebia o que o provider passou a ler — os assets de texto do
        // Google entre eles. `undefined` (provider sem metadata) mantém o gravado.
        metadata: toPrismaJson(input.metadata ?? undefined),
      },
      select: { id: true },
    });

    return row.id;
  }

  /**
   * O upsert do agregado.
   *
   * Duas coisas acontecem aqui e em nenhum outro lugar: a **linhagem nasce**
   * (`lineageId` = próprio id, §3.6) e a **guarda de recência é honrada** —
   * `writeObservedStatus = false` grava tudo menos o status, preservando a
   * intenção mais nova que `platform-actions` registrou.
   */
  async upsertAd(input: UpsertAdInput): Promise<UpsertedAd> {
    // **Um statement, não três.** A primeira redação fazia `findUnique` e então
    // `create`/`update`: numa conta de 5k anúncios são 10 mil idas ao banco só
    // aqui, e o benchmark de §17.2 media 31 s para 500 anúncios — o alvo de
    // 5 min para 5 mil não caberia. O estado anterior de que quem chama precisa
    // (`created`, `previousObservedStatus`, `desiredStatus`) já foi lido em
    // lote pelo `StructureIngestService`, então relê-lo aqui era trabalho
    // duplicado, não segurança.
    const id = randomUUID();

    const row = await this.prisma.ad.upsert({
      where: {
        adAccountId_externalAdId: {
          adAccountId: input.adAccountId,
          externalAdId: input.externalAdId,
        },
      },
      create: {
        id,
        accountId: input.accountId,
        organizationId: input.organizationId,
        adAccountId: input.adAccountId,
        integrationId: input.integrationId,
        platform: input.platform,
        externalAdId: input.externalAdId,
        campaignId: input.campaignId,
        adSetId: input.adSetId,
        creativeId: input.creativeId,
        name: input.name,
        unitKind: input.unitKind,
        // I6: todo anúncio começa a própria linhagem — **exceto** quando sucede
        // um que uma ação nossa recriou (§9.5 passo 6). O `default = próprio id`
        // que §4.3 descreve não é expressável em Prisma, então é aqui que a
        // invariante é imposta, e é o domínio quem dita o valor nos dois casos.
        ...lineageOf(id, input.lineageOrigin ?? null),
        observedStatus: input.observedStatus,
        observedRawStatus: input.observedRawStatus,
        observedAsOf: input.observedAsOf,
        lastStructureSyncAt: input.lastStructureSyncAt,
        syncState: 'IN_SYNC',
        syncStateAt: input.lastStructureSyncAt,
        metadata: toPrismaJson(input.metadata ?? undefined),
      },
      update: {
        integrationId: input.integrationId,
        campaignId: input.campaignId,
        adSetId: input.adSetId,
        creativeId: input.creativeId,
        name: input.name,
        unitKind: input.unitKind,
        lastStructureSyncAt: input.lastStructureSyncAt,
        archivedAt: null,
        // A guarda de §8.4.1 decide **só** sobre o status. Vínculos e nome
        // entram sempre: descrevem o que o anúncio é, não em que estado está.
        ...(input.writeObservedStatus
          ? {
              observedStatus: input.observedStatus,
              observedRawStatus: input.observedRawStatus,
              observedAsOf: input.observedAsOf,
            }
          : {}),
      },
      select: { id: true, lineageId: true },
    });

    return { id: row.id, lineageId: row.lineageId };
  }

  async mapCampaignIds(adAccountId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.campaign.findMany({
      where: { adAccountId },
      select: { id: true, externalCampaignId: true },
    });

    return new Map(rows.map((row) => [row.externalCampaignId, row.id]));
  }

  async mapAdSetIds(adAccountId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.adSet.findMany({
      where: { adAccountId },
      select: { id: true, externalAdSetId: true },
    });

    return new Map(rows.map((row) => [row.externalAdSetId, row.id]));
  }

  async mapCreativeIds(adAccountId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.creative.findMany({
      where: { adAccountId },
      select: { id: true, externalCreativeId: true },
    });

    return new Map(rows.map((row) => [row.externalCreativeId, row.id]));
  }

  async listAdsOfAccount(adAccountId: string): Promise<AdSyncSnapshot[]> {
    const rows = await this.prisma.ad.findMany({
      where: { adAccountId, archivedAt: null },
      select: AD_SELECT,
    });

    return rows.map(toSnapshot);
  }

  async findAdsByExternalIds(
    adAccountId: string,
    externalAdIds: string[],
  ): Promise<AdSyncSnapshot[]> {
    if (externalAdIds.length === 0) return [];

    const rows = await this.prisma.ad.findMany({
      where: { adAccountId, externalAdId: { in: externalAdIds } },
      select: AD_SELECT,
    });

    return rows.map(toSnapshot);
  }

  async findAdsByIds(
    organizationId: string,
    adIds: string[],
  ): Promise<AdSyncSnapshot[]> {
    if (adIds.length === 0) return [];

    const rows = await this.prisma.ad.findMany({
      where: { organizationId, id: { in: adIds } },
      select: AD_SELECT,
    });

    return rows.map(toSnapshot);
  }

  async listForReconciliation(adAccountId: string): Promise<AdSyncSnapshot[]> {
    const rows = await this.prisma.ad.findMany({
      where: { adAccountId, archivedAt: null },
      select: AD_SELECT,
      // Quem tem intenção em voo primeiro: é a fila que a escada de §8.5
      // consome, e ela é a única com prazo.
      orderBy: [{ desiredStatusSetAt: { sort: 'desc', nulls: 'last' } }],
    });

    return rows.map(toSnapshot);
  }

  /**
   * Arquiva os não vistos. **Chamado apenas depois da guarda de §8.2** — este
   * método não conhece a guarda, e é deliberado: uma regra desse peso escondida
   * no repositório é uma regra que ninguém encontra ao investigar por que uma
   * conta inteira sumiu.
   */
  async archiveAdsNotSeen(input: {
    adAccountId: string;
    seenExternalAdIds: string[];
    archivedAt: Date;
  }): Promise<AdSyncSnapshot[]> {
    const toArchive = await this.prisma.ad.findMany({
      where: {
        adAccountId: input.adAccountId,
        archivedAt: null,
        ...(input.seenExternalAdIds.length > 0
          ? { externalAdId: { notIn: input.seenExternalAdIds } }
          : {}),
      },
      select: AD_SELECT,
    });

    if (toArchive.length === 0) return [];

    await this.prisma.ad.updateMany({
      where: { id: { in: toArchive.map((ad) => ad.id) } },
      data: {
        archivedAt: input.archivedAt,
        observedStatus: 'ARCHIVED',
        syncStateAt: input.archivedAt,
      },
    });

    return toArchive.map(toSnapshot);
  }

  async updateDataMaturity(
    updates: Array<{ adId: string; dataMaturity: DataMaturity | null }>,
  ): Promise<void> {
    // Agrupa por valor: são três valores possíveis, então três `updateMany`
    // resolvem o que seriam N updates individuais numa conta de 5k anúncios.
    const byMaturity = new Map<string, string[]>();

    for (const update of updates) {
      const key = update.dataMaturity ?? 'NULL';
      byMaturity.set(key, [...(byMaturity.get(key) ?? []), update.adId]);
    }

    for (const [maturity, adIds] of byMaturity) {
      await this.prisma.ad.updateMany({
        where: { id: { in: adIds } },
        data: {
          dataMaturity: maturity === 'NULL' ? null : (maturity as never),
        },
      });
    }
  }

  async applySyncState(input: {
    adIds: string[];
    syncState: string;
    syncStateAt: Date;
    driftDetails?: Record<string, unknown> | null;
  }): Promise<void> {
    if (input.adIds.length === 0) return;

    await this.prisma.ad.updateMany({
      where: { id: { in: input.adIds } },
      data: {
        syncState: input.syncState as never,
        syncStateAt: input.syncStateAt,
        ...(input.driftDetails !== undefined
          ? { driftDetails: toPrismaJson(input.driftDetails ?? undefined) }
          : {}),
      },
    });
  }

  async touchMetricsSync(input: { adIds: string[]; at: Date }): Promise<void> {
    if (input.adIds.length === 0) return;

    await this.prisma.ad.updateMany({
      where: { id: { in: input.adIds } },
      data: { lastMetricsSyncAt: input.at },
    });
  }
}

function toSnapshot(row: {
  id: string;
  organizationId: string;
  adAccountId: string;
  externalAdId: string;
  lineageId: string;
  observedStatus: string;
  observedAsOf: Date | null;
  desiredStatus: string | null;
  desiredStatusSetAt: Date | null;
  syncState: string;
  driftDetails: unknown;
  lastMetricsSyncAt: Date | null;
  lastStructureSyncAt: Date | null;
  archivedAt: Date | null;
}): AdSyncSnapshot {
  return {
    id: row.id,
    organizationId: row.organizationId,
    adAccountId: row.adAccountId,
    externalAdId: row.externalAdId,
    lineageId: row.lineageId,
    observedStatus: row.observedStatus as AdStatus,
    observedAsOf: row.observedAsOf,
    desiredStatus: (row.desiredStatus as AdStatus | null) ?? null,
    desiredStatusSetAt: row.desiredStatusSetAt,
    syncState: row.syncState,
    driftDetails: (row.driftDetails as Record<string, unknown> | null) ?? null,
    lastMetricsSyncAt: row.lastMetricsSyncAt,
    lastStructureSyncAt: row.lastStructureSyncAt,
    archivedAt: row.archivedAt,
  };
}

/**
 * A linhagem de um anúncio que está nascendo.
 *
 * Sem origem, ele inicia a própria (I6). Com origem, herda o `lineageId` do
 * antecessor — **não o id dele**: uma cadeia de três recriações mantém as três
 * sob a mesma linhagem, e a série continua inteira em vez de se partir a cada
 * troca de criativo (§3.6).
 */
function lineageOf(
  id: string,
  origin: { originAdId: string; lineageId: string; executionId: string } | null,
) {
  if (!origin) return startLineage(id);

  return deriveLineage({
    origin: {
      lineageId: origin.lineageId,
      originAdId: null,
      originActionExecutionId: null,
    },
    originAdId: origin.originAdId,
    originActionExecutionId: origin.executionId,
  });
}
