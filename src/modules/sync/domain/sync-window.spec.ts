import { ingestLookbackDaysFor, restatementWindow } from './sync-window';
import { maturityOfDay } from './data-maturity';

describe('janela do primeiro ingest (backfill)', () => {
  const BASE = {
    restatementDays: 7,
    backfillDays: 30,
    maxLookbackDays: 90,
  };

  it('lê o backfill quando nenhum ingest completo jamais concluiu', () => {
    expect(ingestLookbackDaysFor({ ...BASE, isFirstIngest: true })).toBe(30);
  });

  it('volta à janela de re-declaração assim que existe um ingest bem-sucedido', () => {
    expect(ingestLookbackDaysFor({ ...BASE, isFirstIngest: false })).toBe(7);
  });

  it('nunca lê menos que a janela de re-declaração, mesmo com backfill curto', () => {
    // Uma conta com atribuição de 28 dias tem `restatementDays` 28. Um backfill
    // de 30 configurado para baixo não pode encolher a janela que a atribuição
    // exige — encolher significaria perder conversão retroativa por construção.
    expect(
      ingestLookbackDaysFor({
        isFirstIngest: true,
        restatementDays: 28,
        backfillDays: 10,
        maxLookbackDays: 90,
      }),
    ).toBe(28);
  });

  it('respeita o teto absoluto — o .env não abre uma varredura de um ano', () => {
    expect(
      ingestLookbackDaysFor({
        isFirstIngest: true,
        restatementDays: 7,
        backfillDays: 365,
        maxLookbackDays: 90,
      }),
    ).toBe(90);
  });
});

describe('o backfill entrega dias MATURE no dia do cadastro', () => {
  const NOW = new Date('2026-08-20T12:00:00.000Z');

  /** Quantos dias da janela lida já estão maduros no instante do cadastro. */
  function matureDaysAtSignup(lookbackDays: number): number {
    const { since, until } = restatementWindow(NOW, lookbackDays);
    let mature = 0;

    for (
      const day = new Date(since);
      day <= until;
      day.setUTCDate(day.getUTCDate() + 1)
    ) {
      if (maturityOfDay(new Date(day), NOW) === 'MATURE') mature += 1;
    }

    return mature;
  }

  it('com a janela de 7 dias, nenhum dia chega maduro — a razão do backfill', () => {
    // Um dia só vira MATURE com 14 dias de idade. Lendo 7, o mais velho tem 6.
    // Os detectores de dinheiro exigem MATURE, então o produto fica mudo.
    expect(matureDaysAtSignup(7)).toBe(0);
  });

  it('com 30 dias, sobra evidência madura para o detector mais exigente', () => {
    // `ZERO_CONVERSIONS` pede 5 dias de evidência sobre janela MATURE — o
    // achado mais frequente do catálogo, e o que produz o número em dinheiro.
    expect(matureDaysAtSignup(30)).toBeGreaterThanOrEqual(5);
  });
});
