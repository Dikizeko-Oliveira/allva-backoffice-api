import { peerGroupKeyOf } from 'src/modules/ads/domain/ad-unit';
import { maturityOfWindow } from 'src/modules/sync/domain/data-maturity';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { AdWindowAggregate, DailyPoint } from './detection-context';
import type { DetectableAd } from './ports/waste-targets.repository';

/**
 * §10.7 passo 2 — *"carrega ads ativos + snapshots agregados por ad, **em
 * moeda-base**"*.
 *
 * Função pura: recebe a série já lida e devolve o agregado. Duas coisas
 * acontecem aqui e as duas são normativas.
 *
 * **M1 — linha sem taxa de câmbio fica fora da inteligência.** Somá-la com
 * `spendBase = 0` faria o gasto do período encolher em silêncio, e o detector
 * concluiria que o anúncio gastou menos do que gastou. A exclusão é contada e
 * reportada, nunca escondida.
 *
 * **As duas moedas viajam juntas.** O agregado carrega `spend` e `spendBase`
 * lado a lado porque `WasteItem` persiste as duas (R-M) e derivar uma da outra
 * na hora da escrita exigiria câmbio dentro do domínio — o que só `currency`
 * pode fazer (§16.10).
 */
export function aggregateAdWindow(input: {
  ad: DetectableAd;
  rows: AdMetricSnapshotRow[];
  baseCurrency: string;
  hasValidObservation: boolean;
  /**
   * O instante de referência e a janela de atribuição **da conta**, para a
   * maturidade ser a **desta janela** e não a do dia mais novo da série inteira.
   *
   * Ausentes, cai no campo denormalizado do anúncio — que é o comportamento
   * anterior e continua servindo a quem só quer o selo de leitura.
   */
  now?: Date;
  attributionWindowDays?: number | null;
}): AdWindowAggregate {
  const usable = input.rows.filter((row) => !row.normalizationPending);

  const daily: DailyPoint[] = usable
    .map((row) => ({
      date: row.date,
      spend: row.spend,
      revenue: row.revenue,
      spendBase: row.spendBase,
      revenueBase: row.revenueBase,
      impressions: row.impressions,
      clicks: row.clicks,
      conversions: row.conversions,
      frequency: row.frequency,
    }))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const totals = daily.reduce(
    (sum, point) => ({
      spend: sum.spend + point.spend,
      spendBase: sum.spendBase + point.spendBase,
      revenue: sum.revenue + point.revenue,
      revenueBase: sum.revenueBase + point.revenueBase,
      impressions: sum.impressions + point.impressions,
      clicks: sum.clicks + point.clicks,
      conversions: sum.conversions + point.conversions,
    }),
    {
      spend: 0,
      spendBase: 0,
      revenue: 0,
      revenueBase: 0,
      impressions: 0,
      clicks: 0,
      conversions: 0,
    },
  );

  return {
    adId: input.ad.id,
    adSetId: input.ad.adSetId,
    campaignId: input.ad.campaignId,
    adAccountId: input.ad.adAccountId,
    platform: input.ad.platform,
    unitKind: input.ad.unitKind,
    optimization: input.ad.optimization,
    creativeId: input.ad.creativeId,
    contentHash: input.ad.contentHash,
    isDelivering: input.ad.isDelivering,

    currency: input.ad.currency,
    baseCurrency: input.baseCurrency,

    daily,
    days: daily.length,

    ...totals,

    // CTR em porcentagem, a mesma unidade da série e da tela.
    ctr:
      totals.impressions > 0
        ? (totals.clicks / totals.impressions) * 100
        : null,
    // CPA e ROAS em **moeda-base**: comparar contas em moedas diferentes só é
    // possível aqui (M1), e é contra a mediana da conta que eles são lidos.
    cpa: totals.conversions > 0 ? totals.spendBase / totals.conversions : null,
    roas: totals.spendBase > 0 ? totals.revenueBase / totals.spendBase : null,

    /**
     * A maturidade **da janela**, não a do dia mais novo do anúncio.
     *
     * `Ad.dataMaturity` continua correto para o que ele é — um selo de leitura
     * dizendo "os números recentes ainda podem mudar" — e errado como critério
     * de elegibilidade: num anúncio que entrega todo dia ele nunca sai de
     * `IMMATURE`, e usá-lo como portão desligava seis detectores para sempre.
     */
    dataMaturity: input.now
      ? maturityOfWindow(
          daily.map((point) => point.date),
          input.now,
          input.attributionWindowDays ?? undefined,
        )
      : input.ad.dataMaturity,
    hasValidObservation: input.hasValidObservation,
    excludedByNormalization: input.rows.length - usable.length,
  };
}

/**
 * Os pares do mesmo ad set — **sem o próprio anúncio**, e só os que entregam.
 *
 * Incluir o próprio anúncio no benchmark é o erro que faz um anúncio ruim elevar
 * a própria mediana; incluir os pausados compara desempenho de agora com o de
 * quem parou de rodar semanas atrás.
 *
 * `byPeerGroup` vem agrupado por `peerGroupKeyOf`: o conjunto, e a campanha
 * para a unidade sem conjunto (o grupo de recursos do Performance Max).
 */
export function peersOf(
  ad: AdWindowAggregate,
  byPeerGroup: Map<string, AdWindowAggregate[]>,
): AdWindowAggregate[] {
  return (byPeerGroup.get(peerGroupKeyOf(ad)) ?? []).filter(
    (peer) => peer.adId !== ad.adId && peer.isDelivering && peer.days > 0,
  );
}
