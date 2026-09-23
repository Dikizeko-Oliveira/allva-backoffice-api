import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * Escrita da série diária (§8.2 passos 6–7).
 *
 * **Métricas exclusivamente em nível AD.** Nível campanha e conjunto não existe
 * no armazenamento, e é isso que elimina a classe inteira de bugs de dupla
 * contagem que o `campaignLevelOnly()` do v1 existia para compensar.
 *
 * O upsert é por `(adId, date, granularity)` porque a janela de re-declaração
 * **reescreve o passado**: a mesma linha é gravada N vezes, e a última leitura é
 * a que vale.
 */

export type AdMetricUpsert = {
  adId: string;
  organizationId: string;
  adAccountId: string;
  platform: Platform;
  date: Date;
  campaignId: string;
  adSetId: string | null;
  creativeId: string | null;

  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  revenue: number;
  reach: number | null;
  frequency: number | null;
  videoViews: number | null;
  engagement: number | null;
  thumbstopRate: number | null;
  holdRate: number | null;
  hides: number | null;
  hideAllFor: number | null;
  reports: number | null;
  unlikes: number | null;

  /**
   * Dupla persistência (R-M): original **e** moeda-base, com a taxa fixada na
   * ingestão (M2). Converter na leitura faria o desperdício histórico variar
   * todo dia sem nada ter acontecido com o anúncio.
   */
  currency: string;
  baseCurrency: string;
  spendBase: number;
  revenueBase: number;
  fxRate: number | null;
  fxAsOf: Date | null;
  fxSource: string | null;
  /** Sem taxa a linha **entra assim mesmo**, fora das agregações (M1). */
  normalizationPending: boolean;

  accountTimezone: string;
  attributionSetting: string | null;
  syncedAt: Date;
};

export type IngestedMetricsSummary = {
  rows: number;
  /** Linhas que entraram sem taxa de câmbio — reportadas, nunca escondidas. */
  pendingNormalization: number;
  /** Dias distintos tocados, por ad: insumo da maturidade denormalizada. */
  latestDateByAd: Map<string, Date>;
};

export abstract class AdMetricsIngestRepositoryInterface {
  /**
   * Upsert em lote por `(adId, date, granularity)`.
   *
   * Devolve o resumo em vez de `void` porque quem chama precisa denormalizar
   * `Ad.dataMaturity` a partir do dia mais recente de cada anúncio — e reler a
   * série para descobri-lo seria uma segunda varredura da tabela particionada.
   */
  abstract upsertMany(rows: AdMetricUpsert[]): Promise<IngestedMetricsSummary>;

  /** Último dia com dado por anúncio, para maturidade fora do caminho do ingest. */
  abstract latestDateByAd(adIds: string[]): Promise<Map<string, Date>>;
}
