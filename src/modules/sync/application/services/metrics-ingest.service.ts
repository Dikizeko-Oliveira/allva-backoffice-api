import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ProviderMetricRow } from 'src/modules/integrations/domain/ports';
import { CurrencyConverterService } from 'src/modules/currency/application/currency-converter.service';
import {
  AdMetricUpsert,
  AdMetricsIngestRepositoryInterface,
  IngestedMetricsSummary,
} from 'src/modules/sync/domain/ports/ad-metrics-ingest.repository';
import { AdStructureRepositoryInterface } from 'src/modules/sync/domain/ports/ad-structure.repository';
import { SyncableAdAccount } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { maturityOfDay, utcDay } from 'src/modules/sync/domain/data-maturity';
import type { DateWindow } from 'src/modules/sync/domain/sync-window';

export type MetricsIngestResult = IngestedMetricsSummary & {
  /** Anúncios cuja série foi tocada — quem emite `ad.metrics.updated`. */
  touchedAdIds: string[];
  /** Digest por anúncio (P9): sem mudança, nenhum consumidor recomputa. */
  inputDigestByAd: Map<string, string>;
};

/**
 * Métricas **exclusivamente em nível AD** (§8.2 passo 6).
 *
 * Nível campanha e conjunto não existe no armazenamento. Não é economia de
 * espaço: é o que elimina a classe inteira de bugs de dupla contagem que o
 * `campaignLevelOnly()` do v1 existia para compensar — somar a linha da campanha
 * com as linhas dos seus anúncios conta o mesmo gasto duas vezes, e o número de
 * capa cresce sozinho.
 *
 * Toda linha é normalizada pelo módulo `currency` (§8.2 passo 7). **Taxa
 * ausente não bloqueia**: a linha entra com `normalizationPending = true` e fica
 * fora das agregações de inteligência (M1). Bloquear a ingestão por falta de
 * câmbio trocaria um problema de comparabilidade por um buraco permanente na
 * série.
 */
@Injectable()
export class MetricsIngestService {
  private readonly logger = new Logger(MetricsIngestService.name);

  constructor(
    private readonly metrics: AdMetricsIngestRepositoryInterface,
    private readonly structure: AdStructureRepositoryInterface,
    private readonly currency: CurrencyConverterService,
  ) {}

  async apply(input: {
    account: SyncableAdAccount;
    rows: ProviderMetricRow[];
    window: DateWindow;
    adIdByExternalId: Map<string, string>;
    campaignIdByExternalId: Map<string, string>;
    adSetIdByExternalId: Map<string, string>;
    creativeIdByExternalId: Map<string, string>;
    attributionSetting: string | null;
    now: Date;
  }): Promise<MetricsIngestResult> {
    const { account } = input;

    // Uma leitura de câmbio para a janela inteira. A alternativa — normalizar
    // linha a linha — faria uma consulta por valor, duas por dia por anúncio.
    const fx = await this.currency.tableFor({
      fromCurrency: account.currency,
      toCurrency: account.baseCurrency,
      since: input.window.since,
      until: input.window.until,
    });

    const upserts: AdMetricUpsert[] = [];
    const digestParts = new Map<string, string[]>();

    // Só o nível AD chega ao armazenamento. As linhas de campanha e conjunto que
    // o provider ainda devolve são descartadas **aqui**, e não mais adiante: é o
    // único ponto em que a decisão fica visível para quem lê o código.
    const adRows = input.rows.filter((row) => row.level === 'AD');

    for (const row of adRows) {
      const externalAdId = row.adExternalId ?? row.externalEntityId;
      const adId = input.adIdByExternalId.get(externalAdId);
      // Em quarentena, ou não visto na estrutura desta rodada: a série de um
      // anúncio que o domínio não conhece não tem onde aterrissar.
      if (!adId) continue;

      const campaignId = row.campaignExternalId
        ? input.campaignIdByExternalId.get(row.campaignExternalId)
        : undefined;
      if (!campaignId) continue;

      const date = utcDay(row.date);
      const spend = fx.normalize(row.spend, date);
      const revenue = fx.normalize(row.revenue, date);

      upserts.push({
        adId,
        organizationId: account.organizationId,
        adAccountId: account.id,
        platform: account.platform,
        date,
        campaignId,
        adSetId: row.adSetExternalId
          ? (input.adSetIdByExternalId.get(row.adSetExternalId) ?? null)
          : null,
        creativeId: row.creativeExternalId
          ? (input.creativeIdByExternalId.get(row.creativeExternalId) ?? null)
          : null,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        conversions: row.conversions,
        revenue: row.revenue,
        reach: row.reach ?? null,
        frequency: row.frequency ?? null,
        videoViews: row.videoViews ?? null,
        engagement: row.engagement ?? null,
        thumbstopRate: row.thumbstopRate ?? null,
        holdRate: row.holdRate ?? null,
        // Sinais de feedback negativo (§12.2, A2-S4). Entraram **depois** de
        // `seriesDiscontinuity` estar de pé (§15.2): na ordem inversa, o dia do
        // deploy mudaria o que `NegativeFeedbackRisk` mede em todo anúncio ativo
        // ao mesmo tempo, e o produto reportaria em massa quedas e altas que são
        // artefato de release.
        //
        // `?? null` e não `?? 0`: a plataforma que não expõe o sinal é diferente
        // da que expõe e reporta zero, e é o `null` que faz o componente se
        // declarar indisponível em vez de afirmar risco baixo por ignorância.
        hides: row.hides ?? null,
        hideAllFor: row.hideAllFor ?? null,
        reports: row.reports ?? null,
        unlikes: row.unlikes ?? null,
        currency: account.currency,
        baseCurrency: account.baseCurrency,
        spendBase: spend.valueBase,
        revenueBase: revenue.valueBase,
        fxRate: spend.fxRate,
        fxAsOf: spend.fxAsOf,
        fxSource: spend.fxSource,
        normalizationPending:
          spend.normalizationPending || revenue.normalizationPending,
        accountTimezone: account.timezone,
        attributionSetting: input.attributionSetting,
        syncedAt: input.now,
      });

      const parts = digestParts.get(adId) ?? [];
      parts.push(
        `${date.toISOString().slice(0, 10)}:${row.spend}:${row.impressions}:` +
          `${row.clicks}:${row.conversions}:${row.revenue}:` +
          // Os sinais entram no digest: a chegada deles muda o score, e P9 só
          // economiza corretamente se enxergar essa mudança.
          `${row.hides ?? ''}:${row.hideAllFor ?? ''}:${row.reports ?? ''}:${row.unlikes ?? ''}`,
      );
      digestParts.set(adId, parts);
    }

    const summary = await this.metrics.upsertMany(upserts);

    if (summary.pendingNormalization > 0) {
      this.logger.warn(
        `sync.normalization_pending adAccountId=${account.id} ` +
          `linhas=${summary.pendingNormalization} — entram na série e ficam fora das agregações (M1)`,
      );
    }

    // Denormaliza `Ad.dataMaturity` (A9, §5.4): a maturidade é a do dia mais
    // novo da série do anúncio, contra a janela de atribuição da **conta**.
    await this.structure.updateDataMaturity(
      [...summary.latestDateByAd.entries()].map(([adId, latest]) => ({
        adId,
        dataMaturity: maturityOfDay(
          latest,
          input.now,
          account.attributionWindowDays ?? undefined,
        ),
      })),
    );

    const touchedAdIds = [...summary.latestDateByAd.keys()];
    await this.structure.touchMetricsSync({
      adIds: touchedAdIds,
      at: input.now,
    });

    return {
      ...summary,
      touchedAdIds,
      inputDigestByAd: digestOf(digestParts),
    };
  }
}

/**
 * O digest de entrada por anúncio (P9).
 *
 * *"O custo marginal de analisar um anúncio é limitado."* Sem mudança de
 * digest, nenhum consumidor recomputa — e é isso que impede a janela de
 * re-declaração, que relê os mesmos 14 dias a cada hora, de disparar 14× o
 * custo de scoring e de LLM por anúncio por dia.
 */
function digestOf(parts: Map<string, string[]>): Map<string, string> {
  const digests = new Map<string, string>();

  for (const [adId, values] of parts) {
    digests.set(
      adId,
      createHash('sha256')
        .update([...values].sort().join('|'))
        .digest('hex'),
    );
  }

  return digests;
}
