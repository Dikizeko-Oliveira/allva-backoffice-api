import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * Leitura da série de métricas — **exclusivamente em nível de anúncio**.
 *
 * Não existe `level` aqui, e a ausência é a correção: no v1, snapshots de
 * campanha, conjunto, anúncio e criativo conviviam na mesma tabela, e toda
 * agregação tinha de lembrar de filtrar um nível para não contar o mesmo gasto
 * quatro vezes. Uma granularidade só torna a dupla contagem impossível de
 * escrever, em vez de proibida por disciplina (§4.4).
 *
 * O port nasce em A2-S1 porque `analytics`, `reports`, `notifications` e
 * `billing` precisam ler métrica antes de o módulo `ads` completo existir
 * (A2-S2). É o mínimo: leitura, nada de escrita — quem escreve é o `sync`, e ele
 * chega em A2-S3.
 */
export type AdMetricSnapshotRow = {
  adId: string;
  organizationId: string;
  adAccountId: string;
  campaignId: string;
  adSetId: string | null;
  creativeId: string | null;
  platform: Platform;
  date: Date;

  /// Moeda da conta — o que a plataforma reportou (R-M).
  spend: number;
  revenue: number;
  currency: string;

  /// Moeda-base da organização. **É o que a inteligência lê** (M1): comparar
  /// contas em moedas diferentes só é possível aqui.
  spendBase: number;
  revenueBase: number;
  baseCurrency: string;
  /// Taxa do dia indisponível na ingestão: a linha fica fora das agregações de
  /// inteligência e reduz `evidenceSufficiency` — nunca bloqueia a ingestão.
  normalizationPending: boolean;

  impressions: number;
  clicks: number;
  conversions: number;

  reach: number | null;
  frequency: number | null;
  videoViews: number | null;
  engagement: number | null;
  thumbstopRate: number | null;
  holdRate: number | null;

  /// Sinais de feedback negativo (§12.2). Nulos até o sync passar a coletá-los.
  hides: number | null;
  hideAllFor: number | null;
  reports: number | null;
  unlikes: number | null;

  /// O motivo, nunca um booleano (§12.5, A12). `null` = série contínua.
  seriesDiscontinuity: string | null;
  syncedAt: Date;
};

export type AdMetricsQuery = {
  organizationId?: string | null;
  accountId?: string;
  adAccountIds?: string[];
  platforms?: Platform[];
  adIds?: string[];
  campaignIds?: string[];
  since: Date;
  until: Date;
};

export abstract class AdMetricsRepositoryInterface {
  abstract query(query: AdMetricsQuery): Promise<AdMetricSnapshotRow[]>;

  /** Quantos anúncios distintos tiveram gasto na janela — usado pelo billing. */
  abstract countActiveAds(query: AdMetricsQuery): Promise<number>;
}
