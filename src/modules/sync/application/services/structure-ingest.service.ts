import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  ProviderAd,
  ProviderAdSet,
  ProviderCampaign,
  ProviderCreative,
} from 'src/modules/integrations/domain/ports';
import {
  platformProfile,
  toCanonicalStatus,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import {
  AdStructureRepositoryInterface,
  UpsertedAd,
} from 'src/modules/sync/domain/ports/ad-structure.repository';
import { AdLineageOriginReader } from 'src/modules/ads/domain/ports/ad-lineage-origin.reader';
import { SyncQuarantineRepositoryInterface } from 'src/modules/sync/domain/ports/sync-quarantine.repository';
import { SyncableAdAccount } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import {
  evaluateQuarantineItem,
  QuarantineReason,
} from 'src/modules/sync/domain/quarantine';
import {
  evaluateRecency,
  resolveObservedAsOf,
} from 'src/modules/sync/domain/recency-guard';
import {
  detectExternalChange,
  ExternalChangeCause,
} from 'src/modules/sync/domain/drift';

export type StructureIngestResult = {
  campaignsUpserted: number;
  adSetsUpserted: number;
  creativesUpserted: number;
  adsUpserted: number;
  /** `externalAdId → id` dos anúncios vivos depois desta passagem. */
  adIdByExternalId: Map<string, string>;
  /** Os que entraram agora — emitem `ad.discovered`. */
  discovered: UpsertedAd[];
  /**
   * Mudanças de status observadas — §8.5(b) **acontece aqui**, e não na
   * reconciliação: este é o único ponto que vê ao mesmo tempo o valor que
   * chegou da plataforma e o que estava gravado. Guardar uma cópia do status
   * anterior só para a reconciliação comparar criaria duas fontes para o mesmo
   * fato, e a divergência entre elas seria invisível.
   */
  statusChanges: Array<{
    adId: string;
    from: AdStatus;
    to: AdStatus;
    hadDesiredStatus: boolean;
    /** `null` quando a mudança é consequência de uma ação nossa. */
    externalCause: ExternalChangeCause | null;
  }>;
  quarantined: number;
  quarantineResolved: number;
  /** Ids externos efetivamente vistos — insumo da guarda de arquivamento. */
  seenExternalAdIds: string[];
};

/**
 * Upsert da hierarquia em **ordem de FK**, resolvendo external ids por
 * `adAccountId` (§8.2 passo 5, P10).
 *
 * *"Ad sem campanha/adset resolvível ⇒ `sync_quarantine` — não aborta e não
 * descarta."* As duas metades importam: abortar perde a conta inteira por causa
 * de um anúncio, e descartar perde o anúncio em silêncio. E a quarentena só
 * deixa de ser cemitério porque **toda passagem tenta re-resolver o que está lá**
 * antes de processar o que chegou (C6).
 */
@Injectable()
export class StructureIngestService {
  private readonly logger = new Logger(StructureIngestService.name);

  constructor(
    private readonly structure: AdStructureRepositoryInterface,
    private readonly quarantine: SyncQuarantineRepositoryInterface,
    private readonly lineageOrigins: AdLineageOriginReader,
  ) {}

  async apply(input: {
    account: SyncableAdAccount;
    integrationId: string;
    campaigns: ProviderCampaign[];
    adSets: ProviderAdSet[];
    ads: ProviderAd[];
    creatives: ProviderCreative[];
    /**
     * A leitura desta passada cobriu a conta inteira?
     *
     * Só quem varreu tudo pode concluir alguma coisa a partir de **ausência** —
     * é a mesma regra do passo 9 (§8.2), aqui aplicada à quarentena. Numa
     * leitura por `updated_since`, ou dirigida por ids, um anúncio que não veio
     * apenas não mudou.
     */
    fullScan: boolean;
    syncStartedAt: Date;
    now: Date;
  }): Promise<StructureIngestResult> {
    const { account } = input;
    const profile = platformProfile(account.platform);

    const campaignIds = await this.upsertCampaigns(input);
    const adSetIds = await this.upsertAdSets(input, campaignIds);
    const creativeIds = await this.upsertCreatives(input);

    // A quarentena é lida ANTES de processar: um item cujo pai chegou nesta
    // leitura entra no domínio agora, não na próxima janela.
    const pending = await this.quarantine.listOpen(account.id);
    const pendingByExternalId = new Map(
      pending.map((item) => [item.externalAdId, item]),
    );
    const adsByExternalId = new Map(
      input.ads.map((ad) => [ad.externalAdId, ad]),
    );

    // Uma consulta para toda a conta, não uma por anúncio. A guarda de recência
    // precisa de `desiredStatusSetAt` de cada ad e, num ingest de 5k anúncios,
    // consultá-los um a um custa mais que a chamada de plataforma inteira — o
    // alvo de §17.2 é < 5 min para a conta toda.
    const existingByExternalId = new Map(
      (
        await this.structure.findAdsByExternalIds(
          account.id,
          input.ads.map((ad) => ad.externalAdId),
        )
      ).map((ad) => [ad.externalAdId, ad]),
    );

    /**
     * §9.5 passo 6 — de quem cada anúncio **novo** nasceu.
     *
     * Uma consulta por ingest, só para os que o domínio ainda não conhece: um
     * anúncio já existente não pode ter acabado de ser criado por uma ação
     * nossa. Perguntar por anúncio custaria uma ida ao banco por linha numa
     * conta de 5 mil, e o alvo de §17.2 é a conta inteira em < 5 min.
     */
    const lineageOrigins = await this.lineageOrigins.findOriginFor({
      organizationId: account.organizationId,
      adAccountId: account.id,
      externalAdIds: input.ads
        .map((ad) => ad.externalAdId)
        .filter((externalAdId) => !existingByExternalId.has(externalAdId)),
    });

    const result: StructureIngestResult = {
      campaignsUpserted: campaignIds.size,
      adSetsUpserted: adSetIds.size,
      creativesUpserted: creativeIds.size,
      adsUpserted: 0,
      adIdByExternalId: new Map(),
      discovered: [],
      statusChanges: [],
      quarantined: 0,
      quarantineResolved: 0,
      seenExternalAdIds: [],
    };

    const resolvedQuarantineIds: string[] = [];
    const disappearedQuarantineIds: string[] = [];
    const abandonedQuarantineIds: string[] = [];

    for (const ad of input.ads) {
      result.seenExternalAdIds.push(ad.externalAdId);

      const campaignId = campaignIds.get(ad.campaignExternalId);
      const adSetId = ad.adSetExternalId
        ? (adSetIds.get(ad.adSetExternalId) ?? null)
        : null;

      const unresolved = this.unresolvedReason({
        campaignId,
        adSetId,
        hasAdSetExternalId: Boolean(ad.adSetExternalId),
        hasAdSetLevel: profile.hierarchy.hasAdSetLevel,
      });

      if (unresolved || !campaignId) {
        await this.quarantine.record({
          organizationId: account.organizationId,
          adAccountId: account.id,
          externalAdId: ad.externalAdId,
          reason: unresolved ?? 'MISSING_PARENT_REFERENCE',
          payload: {
            campaignExternalId: ad.campaignExternalId,
            adSetExternalId: ad.adSetExternalId,
            name: ad.name,
          },
          now: input.now,
        });
        result.quarantined += 1;
        continue;
      }

      const observed = resolveObservedAsOf({
        platformTimestamp: ad.updatedAt ?? null,
        syncStartedAt: input.syncStartedAt,
        exposesDataTimestamp: profile.sync.exposesDataTimestamp,
      });

      const recency = evaluateRecency({
        observed,
        desiredStatusSetAt:
          existingByExternalId.get(ad.externalAdId)?.desiredStatusSetAt ?? null,
      });

      const upserted = await this.structure.upsertAd({
        adAccountId: account.id,
        accountId: account.accountId,
        organizationId: account.organizationId,
        integrationId: input.integrationId,
        platform: account.platform,
        externalAdId: ad.externalAdId,
        campaignId,
        adSetId,
        creativeId: ad.creativeExternalId
          ? (creativeIds.get(ad.creativeExternalId) ?? null)
          : null,
        name: ad.name,
        unitKind: ad.unitKind ?? 'AD',
        observedStatus: this.canonicalStatusOf(account, ad.status),
        observedRawStatus: ad.status ?? null,
        observedAsOf: observed.observedAsOf,
        writeObservedStatus: recency.writeStatus,
        lastStructureSyncAt: input.now,
        metadata: recency.writeStatus
          ? null
          : { observedStatusIgnored: recency.reason },
        /**
         * Presente só quando este anúncio é o **sucessor** de outro que uma
         * ação nossa recriou. `null` é o caso comum: quase todo anúncio
         * descoberto é um anúncio que o usuário criou no gerenciador, e esse
         * começa a própria linhagem.
         */
        lineageOrigin: lineageOrigins.get(ad.externalAdId) ?? null,
      });

      result.adsUpserted += 1;
      result.adIdByExternalId.set(ad.externalAdId, upserted.id);

      // O estado anterior vem do lote já lido, não de uma segunda consulta por
      // anúncio. Ausência no mapa significa **descoberta**: o anúncio não
      // existia no domínio antes desta leitura.
      const previous = existingByExternalId.get(ad.externalAdId) ?? null;
      if (!previous) result.discovered.push(upserted);

      const previousStatus = previous?.observedStatus ?? 'UNKNOWN';
      const nextStatus = this.canonicalStatusOf(account, ad.status);

      if (recency.writeStatus && previousStatus !== nextStatus) {
        const external = detectExternalChange({
          previousObserved: previousStatus,
          observedStatus: nextStatus,
          desiredStatus: previous?.desiredStatus ?? null,
        });

        result.statusChanges.push({
          adId: upserted.id,
          from: previousStatus,
          to: nextStatus,
          hadDesiredStatus: Boolean(previous?.desiredStatus),
          externalCause: external?.cause ?? null,
        });
      }

      const quarantined = pendingByExternalId.get(ad.externalAdId);
      if (quarantined) resolvedQuarantineIds.push(quarantined.id);
    }

    // O que continua na quarentena e o que sai dela por outros motivos.
    for (const item of pending) {
      if (resolvedQuarantineIds.includes(item.id)) continue;

      const stillPresent = adsByExternalId.has(item.externalAdId);

      /**
       * **Varredura incremental não decide sobre ausência** — a mesma frase que
       * o passo 9 usa para não arquivar, e que faltava aqui.
       *
       * `updated_since` devolve o que mudou. Um anúncio parado na quarentena
       * por pai não resolvido não mudou, logo não vem — e concluir
       * `AD_DISAPPEARED` disso fecha a quarentena de um anúncio que existe e
       * gasta. Pior que perder o anúncio: o caminho de volta de C6 morre junto,
       * porque item resolvido nunca mais é reavaliado, e a conta fica sem ele
       * para sempre sem nada em `sync_quarantine` para investigar.
       *
       * Ficar em silêncio aqui é a leitura honesta: não aprendemos nada sobre
       * este item nesta passada. `attempts` também não sobe — quem o incrementa
       * é `record()`, e ele só roda sobre anúncio efetivamente lido. Sem isso,
       * 30 passadas incrementais em 30 horas abandonariam um item que a regra
       * quer abandonar depois de 30 leituras de verdade.
       */
      if (!stillPresent && !input.fullScan) continue;

      const verdict = evaluateQuarantineItem({
        item: {
          externalAdId: item.externalAdId,
          attempts: item.attempts,
          reason: item.reason as QuarantineReason,
        },
        stillPresent,
        parentResolvable: false,
      });

      if (verdict.kind !== 'RESOLVE') continue;
      if (verdict.resolution === 'AD_DISAPPEARED') {
        disappearedQuarantineIds.push(item.id);
      } else if (verdict.resolution === 'ABANDONED') {
        abandonedQuarantineIds.push(item.id);
      }
    }

    result.quarantineResolved =
      (await this.quarantine.resolve({
        ids: resolvedQuarantineIds,
        resolution: 'PARENT_APPEARED',
        at: input.now,
      })) +
      (await this.quarantine.resolve({
        ids: disappearedQuarantineIds,
        resolution: 'AD_DISAPPEARED',
        at: input.now,
      })) +
      (await this.quarantine.resolve({
        ids: abandonedQuarantineIds,
        resolution: 'ABANDONED',
        at: input.now,
      }));

    if (result.quarantined > 0) {
      this.logger.warn(
        `sync.quarantined adAccountId=${account.id} itens=${result.quarantined}`,
      );
    }

    return result;
  }

  /**
   * Por que este anúncio não pode entrar no domínio.
   *
   * O conjunto só é exigido nas plataformas cujo perfil declara o nível
   * intermediário — `adSetId` é nullable **por design** (§4.3), e cobrar um
   * conjunto de quem não tem colocaria a conta inteira em quarentena.
   */
  private unresolvedReason(input: {
    campaignId: string | undefined;
    adSetId: string | null;
    hasAdSetExternalId: boolean;
    hasAdSetLevel: boolean;
  }): QuarantineReason | null {
    if (!input.campaignId) return 'CAMPAIGN_NOT_RESOLVED';
    if (input.hasAdSetLevel && input.hasAdSetExternalId && !input.adSetId) {
      return 'AD_SET_NOT_RESOLVED';
    }
    return null;
  }

  /**
   * Status bruto → canônico pelo `PlatformProfile` (P6).
   *
   * O mapa é dado declarativo por plataforma; um `switch` aqui seria o
   * `if (platform === …)` que a regra de lint proíbe fora de `providers/`.
   * Valor desconhecido vira `UNKNOWN` e **não** vira `PAUSED`: chutar aqui é
   * como o produto passa a reportar pausa que não existe.
   */
  private canonicalStatusOf(
    account: SyncableAdAccount,
    raw: string | null | undefined,
  ): AdStatus {
    // Sem status a plataforma não disse nada; `UNKNOWN` é a leitura honesta.
    if (!raw) return 'UNKNOWN';
    return toCanonicalStatus(account.platform, raw);
  }

  private async upsertCampaigns(input: {
    account: SyncableAdAccount;
    integrationId: string;
    campaigns: ProviderCampaign[];
  }): Promise<Map<string, string>> {
    const ids = await this.structure.mapCampaignIds(input.account.id);

    for (const campaign of input.campaigns) {
      const id = await this.structure.upsertCampaign({
        adAccountId: input.account.id,
        organizationId: input.account.organizationId,
        integrationId: input.integrationId,
        platform: input.account.platform,
        externalCampaignId: campaign.externalCampaignId,
        name: campaign.name,
        status: campaign.status ?? null,
        objective: campaign.objective ?? null,
        optimization: campaign.optimization,
        dailyBudget: campaign.dailyBudget ?? null,
        lifetimeBudget: campaign.lifetimeBudget ?? null,
        currency: campaign.currency ?? input.account.currency,
        startedAt: campaign.startedAt ?? null,
        endedAt: campaign.endedAt ?? null,
        metadata: campaign.metadata ?? null,
      });
      ids.set(campaign.externalCampaignId, id);
    }

    return ids;
  }

  private async upsertAdSets(
    input: {
      account: SyncableAdAccount;
      adSets: ProviderAdSet[];
    },
    campaignIds: Map<string, string>,
  ): Promise<Map<string, string>> {
    const ids = await this.structure.mapAdSetIds(input.account.id);

    for (const adSet of input.adSets) {
      const campaignId = campaignIds.get(adSet.campaignExternalId);
      // Conjunto órfão não vai para quarentena: a quarentena é do anúncio, que é
      // a unidade de verdade (P2). Um conjunto sem campanha resolvível reaparece
      // na varredura completa do dia, e os anúncios dele ficam retidos até lá.
      if (!campaignId) continue;

      const id = await this.structure.upsertAdSet({
        adAccountId: input.account.id,
        organizationId: input.account.organizationId,
        campaignId,
        platform: input.account.platform,
        externalAdSetId: adSet.externalAdSetId,
        name: adSet.name,
        status: adSet.status ?? null,
        optimizationGoal: adSet.optimizationGoal ?? null,
        billingEvent: adSet.billingEvent ?? null,
        optimization: adSet.optimization,
        dailyBudget: adSet.dailyBudget ?? null,
        lifetimeBudget: adSet.lifetimeBudget ?? null,
        targeting: adSet.targeting ?? null,
      });
      ids.set(adSet.externalAdSetId, id);
    }

    return ids;
  }

  private async upsertCreatives(input: {
    account: SyncableAdAccount;
    creatives: ProviderCreative[];
  }): Promise<Map<string, string>> {
    const ids = await this.structure.mapCreativeIds(input.account.id);

    for (const creative of input.creatives) {
      const id = await this.structure.upsertCreative({
        adAccountId: input.account.id,
        organizationId: input.account.organizationId,
        platform: input.account.platform,
        externalCreativeId: creative.externalCreativeId,
        name: creative.name ?? null,
        title: creative.title ?? null,
        body: creative.body ?? null,
        callToAction: creative.callToAction ?? null,
        format: creative.format ?? null,
        thumbnailUrl: creative.thumbnailUrl ?? null,
        videoUrl: creative.videoUrl ?? null,
        imageUrl: creative.imageUrl ?? null,
        landingPageUrl: creative.landingPageUrl ?? null,
        contentHash: contentHashOf(creative),
        metadata: creative.metadata ?? null,
      });
      ids.set(creative.externalCreativeId, id);
    }

    return ids;
  }
}

/**
 * A impressão digital do conteúdo do criativo.
 *
 * Sustenta `OVERLAPPING_DELIVERY` na v2.0 (DEC-5: mesmo `contentHash` no mesmo
 * conjunto) e a dissimilaridade de candidatos de §11.4. O id da plataforma **não**
 * serve: duplicar um anúncio gera criativo novo com o mesmo conteúdo, que é
 * precisamente o caso que o detector precisa enxergar.
 */
export function contentHashOf(creative: ProviderCreative): string {
  const parts = [
    creative.title ?? '',
    creative.body ?? '',
    creative.callToAction ?? '',
    creative.imageUrl ?? '',
    creative.videoUrl ?? '',
    creative.landingPageUrl ?? '',
  ]
    .map((part) => part.trim().toLowerCase())
    .join(' ');

  return createHash('sha256').update(parts).digest('hex');
}
