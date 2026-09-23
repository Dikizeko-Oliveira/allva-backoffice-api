import { Injectable, Logger } from '@nestjs/common';
import { isSyncableIntegrationStatus } from 'src/modules/integrations/domain/entities/integration.entity';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { AdStructureRepositoryInterface } from 'src/modules/sync/domain/ports/ad-structure.repository';
import { SyncOperationsRepositoryInterface } from 'src/modules/sync/domain/ports/sync-operations.repository';
import { restatementWindow } from 'src/modules/sync/domain/sync-window';
import { restatementWindowDaysFor } from 'src/modules/sync/domain/data-maturity';
import { MetricsIngestService } from './metrics-ingest.service';
import { PlatformBudgetService } from './platform-budget.service';
import { toProviderAdAccount } from './provider-ad-account';
import { StructureIngestService } from './structure-ingest.service';

export type RefreshOutcome = {
  requested: number;
  refreshed: number;
  /** Ignorados pelo debounce — informação de produto, não erro. */
  debounced: number;
  /** Contas fora de alcance: o refresh não inventa dado que não conseguiu ler. */
  skippedUnreachable: number;
};

/**
 * ② REFRESH dirigido por Ad (§8.3).
 *
 * ```text
 * Ad → credencial via AdAccount → fetch de UM ad (status + insights da janela)
 *    → upsert de snapshot + observedStatus com guarda de recência
 *    → SyncOperation(kind = AD_REFRESH, adId)
 * ```
 *
 * **Debounce de 60 s por anúncio** e **coalescência por conta**: `POST
 * /ads/sync-batch` com trinta ids vira uma chamada de insights, não trinta. Sem
 * as duas, a tela de detalhe consome sozinha o orçamento que R4 protege — e o
 * corte da plataforma atinge também as escritas, que são as que movem dinheiro.
 */
@Injectable()
export class RefreshAdsService {
  private readonly logger = new Logger(RefreshAdsService.name);

  /**
   * O debounce é em memória e por processo, deliberadamente.
   *
   * Ele protege contra o mesmo usuário insistindo no botão, que é o caso real —
   * e esse caso chega sempre na mesma réplica dentro de 60 s. Levá-lo para o
   * Redis custaria um round-trip por anúncio para cobrir um cenário (mesma
   * pessoa, duas réplicas, um minuto) cujo pior desfecho é uma chamada a mais.
   */
  private readonly lastRefreshAt = new Map<string, number>();

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly structure: AdStructureRepositoryInterface,
    private readonly operations: SyncOperationsRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly structureIngest: StructureIngestService,
    private readonly metricsIngest: MetricsIngestService,
    private readonly budget: PlatformBudgetService,
    private readonly events: DomainEventBus,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    organizationId: string;
    adIds: string[];
    ctx: JobContext;
    now?: Date;
  }): Promise<RefreshOutcome> {
    const now = input.now ?? new Date();
    const debounceMs = this.env.get('ADS_SYNC_COOLDOWN_SECONDS') * 1000;

    const eligible = input.adIds.filter((adId) => {
      const last = this.lastRefreshAt.get(adId);
      return !last || now.getTime() - last >= debounceMs;
    });

    const outcome: RefreshOutcome = {
      requested: input.adIds.length,
      refreshed: 0,
      debounced: input.adIds.length - eligible.length,
      skippedUnreachable: 0,
    };

    if (eligible.length === 0) return outcome;

    const byAccount = await this.groupByAccount(input.organizationId, eligible);

    for (const [adAccountId, ads] of byAccount) {
      const refreshed = await this.refreshAccountBatch({
        adAccountId,
        externalAdIds: ads.map((ad) => ad.externalAdId),
        ctx: input.ctx,
        now,
      });

      if (refreshed === null) {
        outcome.skippedUnreachable += ads.length;
        continue;
      }

      outcome.refreshed += refreshed;
      for (const ad of ads) this.lastRefreshAt.set(ad.id, now.getTime());
    }

    return outcome;
  }

  /**
   * Coalesce por conta — é o que transforma trinta pedidos em uma chamada.
   *
   * A consulta é uma só e já filtra `organizationId`: varrer conta a conta
   * atrás dos ids faria a rota de refresh custar uma leitura por conta da
   * organização, e a maioria não tem nenhum dos anúncios pedidos.
   */
  private async groupByAccount(
    organizationId: string,
    adIds: string[],
  ): Promise<Map<string, Array<{ id: string; externalAdId: string }>>> {
    const grouped = new Map<
      string,
      Array<{ id: string; externalAdId: string }>
    >();

    for (const ad of await this.structure.findAdsByIds(organizationId, adIds)) {
      const bucket = grouped.get(ad.adAccountId) ?? [];
      bucket.push({ id: ad.id, externalAdId: ad.externalAdId });
      grouped.set(ad.adAccountId, bucket);
    }

    return grouped;
  }

  /** `null` quando a conta não está alcançável — nada é inventado. */
  private async refreshAccountBatch(input: {
    adAccountId: string;
    externalAdIds: string[];
    ctx: JobContext;
    now: Date;
  }): Promise<number | null> {
    const account = await this.accounts.findById(input.adAccountId);
    if (!account?.integrationId) return null;
    if (account.syncHealth === 'UNREACHABLE') return null;

    const integration = await this.integrations.findById(account.integrationId);
    if (!integration) return null;
    // Credencial que não se lê não é lida: a chamada falharia igual.
    if (!isSyncableIntegrationStatus(integration.status)) return null;

    const emit = { ...input.ctx, organizationId: account.organizationId };
    const window = restatementWindow(
      input.now,
      restatementWindowDaysFor({
        attributionWindowDays: account.attributionWindowDays,
        envMinimumDays: this.env.get('ADS_SYNC_LOOKBACK_DAYS'),
      }),
    );

    const operation = await this.operations.open({
      organizationId: account.organizationId,
      integrationId: integration.id,
      adAccountId: account.id,
      direction: 'INBOUND',
      kind: 'AD_REFRESH',
      trigger: 'MANUAL',
      windowStart: window.since,
      windowEnd: window.until,
    });

    const provider = this.providers.for(account.platform);
    const result = await this.budget.spend(integration.id, () =>
      provider.syncAdAccountMetrics(
        toProviderAdAccount(account, integration),
        integration,
        { since: window.since, until: window.until },
        { levels: ['AD'], adExternalIds: input.externalAdIds },
      ),
    );

    // A plataforma pode não honrar o filtro de ids (o perfil não promete isso em
    // toda plataforma). Filtrar de novo aqui é barato e mantém o refresh
    // dirigido de fato dirigido — sem isso, "atualizar um anúncio" reescreveria
    // a série da conta inteira.
    const wanted = new Set(input.externalAdIds);
    const ads = (result.ads ?? []).filter((ad) => wanted.has(ad.externalAdId));

    const structure = await this.structureIngest.apply({
      account,
      integrationId: integration.id,
      campaigns: result.campaigns,
      adSets: result.adSets ?? [],
      ads,
      creatives: result.creatives ?? [],
      // ② lê os ids que pediu, e mais nada. Ausência aqui não é informação
      // sobre a conta — é o filtro funcionando.
      fullScan: false,
      syncStartedAt: operation.startedAt,
      now: input.now,
    });

    const metrics = await this.metricsIngest.apply({
      account,
      rows: result.metrics.filter((row) =>
        wanted.has(row.adExternalId ?? row.externalEntityId),
      ),
      window,
      adIdByExternalId: structure.adIdByExternalId,
      campaignIdByExternalId: await this.structure.mapCampaignIds(account.id),
      adSetIdByExternalId: await this.structure.mapAdSetIds(account.id),
      creativeIdByExternalId: await this.structure.mapCreativeIds(account.id),
      attributionSetting: null,
      now: input.now,
    });

    for (const adId of metrics.touchedAdIds) {
      this.events.emitFrom(emit, 'ad.metrics.updated', {
        adId,
        dateRange: {
          from: window.since.toISOString().slice(0, 10),
          to: window.until.toISOString().slice(0, 10),
        },
        inputDigest: metrics.inputDigestByAd.get(adId) ?? '',
      });
    }

    await this.operations.close(operation.id, {
      status: result.wasComplete ? 'SUCCEEDED' : 'PARTIAL',
      entitiesRead: ads.length,
      entitiesWritten: structure.adsUpserted,
      // **Refresh nunca arquiva.** `wasComplete` aqui descreve o lote pedido, e
      // um lote não é a conta: deixá-lo entrar na guarda de §8.2 seria autorizar
      // "não vi os outros 4.970 anúncios, então eles não existem mais".
      wasComplete: false,
      stepResults: [
        { step: 'STRUCTURE', status: 'SUCCEEDED', count: ads.length },
        { step: 'METRICS', status: 'SUCCEEDED', count: metrics.rows },
      ],
    });

    // O perfil da plataforma decide se o status observado tem instante próprio;
    // o resto da guarda de recência já foi aplicado no upsert.
    const profile = platformProfile(account.platform);
    this.logger.debug(
      `sync.refresh adAccountId=${account.id} ads=${ads.length} ` +
        `timestampDaPlataforma=${profile.sync.exposesDataTimestamp}`,
    );

    return structure.adsUpserted;
  }
}
