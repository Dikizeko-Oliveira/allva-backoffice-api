import { aggregateAdWindow } from './window-aggregate';
import {
  MINIMUM_MATURITY_BY_FINDING,
  maturityLagDays,
  satisfiesMaturity,
} from 'src/modules/sync/domain/data-maturity';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import type { DetectableAd } from './ports/waste-targets.repository';

/**
 * O teste que faltava, e é por isso que o defeito passou.
 *
 * Os specs existentes afirmavam o valor **estático** de `dataMaturity`. Nenhum
 * percorria vários ciclos de um anúncio que nunca para de entregar — que é
 * exatamente a condição em que o portão ficava fechado para sempre: a
 * maturidade era lida do dia mais novo da série, e num anúncio ativo esse dia é
 * sempre ontem.
 */

const ATTRIBUTION_DAYS = 7;
const WINDOW_DAYS = 14;

const ad = {
  id: 'ad-1',
  adSetId: 'set-1',
  campaignId: 'campaign-1',
  platform: 'META',
  isDelivering: true,
  currency: 'BRL',
  dataMaturity: 'IMMATURE',
} as unknown as DetectableAd;

/** Um anúncio que entrega todo santo dia, sem nunca pausar. */
function seriesEndingYesterday(now: Date, days: number): AdMetricSnapshotRow[] {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - (days - index));
    date.setUTCHours(0, 0, 0, 0);

    return {
      adId: ad.id,
      date,
      spend: 100,
      spendBase: 100,
      revenue: 0,
      revenueBase: 0,
      impressions: 2000,
      clicks: 20,
      conversions: 0,
      frequency: 1.2,
      normalizationPending: false,
    } as unknown as AdMetricSnapshotRow;
  });
}

/** O recorte que a classe de maturidade julga: recuado pela defasagem. */
function sliceFor(
  now: Date,
  rows: AdMetricSnapshotRow[],
  lagDays: number,
): AdMetricSnapshotRow[] {
  const until = new Date(now);
  until.setUTCHours(0, 0, 0, 0);
  until.setUTCDate(until.getUTCDate() - lagDays);

  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - WINDOW_DAYS + 1);

  return rows.filter((row) => row.date >= since && row.date <= until);
}

describe('portão de maturidade em anúncio continuamente ativo', () => {
  it('a janela julgada amadurece mesmo com o anúncio entregando todo dia', () => {
    const now = new Date('2026-09-06T06:00:00.000Z');
    const rows = seriesEndingYesterday(now, 60);

    for (const [finding, required] of Object.entries(
      MINIMUM_MATURITY_BY_FINDING,
    )) {
      const lag = maturityLagDays(required, ATTRIBUTION_DAYS);

      const aggregate = aggregateAdWindow({
        ad,
        rows: sliceFor(now, rows, lag),
        baseCurrency: 'BRL',
        hasValidObservation: true,
        now,
        attributionWindowDays: ATTRIBUTION_DAYS,
      });

      expect({
        finding,
        satisfies: satisfiesMaturity(aggregate.dataMaturity, required),
      }).toEqual({ finding, satisfies: true });
    }
  });

  it('vinte ciclos diários seguidos não travam o portão', () => {
    // O defeito: a cada ingest o dia mais novo era ontem de novo, e a idade
    // medida nunca crescia. Vinte madrugadas seguidas produziam vinte
    // `IMMATURE`.
    const veredicts = new Set<boolean>();

    for (let day = 0; day < 20; day++) {
      const now = new Date('2026-09-06T06:00:00.000Z');
      now.setUTCDate(now.getUTCDate() + day);

      const aggregate = aggregateAdWindow({
        ad,
        rows: sliceFor(
          now,
          seriesEndingYesterday(now, 60),
          maturityLagDays('MATURE', ATTRIBUTION_DAYS),
        ),
        baseCurrency: 'BRL',
        hasValidObservation: true,
        now,
        attributionWindowDays: ATTRIBUTION_DAYS,
      });

      veredicts.add(satisfiesMaturity(aggregate.dataMaturity, 'MATURE'));
    }

    expect(veredicts).toEqual(new Set([true]));
  });

  it('a janela sem defasagem continua imatura — o selo de leitura não mente', () => {
    const now = new Date('2026-09-06T06:00:00.000Z');

    const aggregate = aggregateAdWindow({
      ad,
      rows: sliceFor(now, seriesEndingYesterday(now, 60), 0),
      baseCurrency: 'BRL',
      hasValidObservation: true,
      now,
      attributionWindowDays: ATTRIBUTION_DAYS,
    });

    // O que muda é qual janela o portão julga, não a verdade sobre os dias
    // recentes: eles seguem em re-declaração, e o produto segue dizendo isso.
    expect(aggregate.dataMaturity).toBe('IMMATURE');
  });

  it('a defasagem cresce com a janela de atribuição da conta', () => {
    expect(maturityLagDays('MATURE', 7)).toBe(14);
    expect(maturityLagDays('MATURE', 28)).toBe(56);
    expect(maturityLagDays('SETTLING', 7)).toBe(7);
    // Sem exigência não há defasagem: a janela termina hoje, que é o mais
    // acionável para quem precisa agir agora.
    expect(maturityLagDays('IMMATURE', 7)).toBe(0);
  });
});
