import {
  SERIES_DISCONTINUITY_REASONS,
  asDiscontinuityReason,
  breaksSeries,
} from './series-discontinuity';

/**
 * §12.5 — a descontinuidade é o **motivo**, não um booleano (A12, ⊕4).
 *
 * O achado A12 foi declarado aplicado em A2-S1 e só metade dele foi:
 * `ad_scores` nasceu `String?` e `ad_metric_snapshots` nasceu `Boolean`. Estes
 * testes existem para que a segunda metade não volte a divergir — e para fixar
 * que "desconhecido" não é a mesma coisa que "quebrou".
 */
describe('descontinuidade de série (§12.5)', () => {
  it('declara as cinco causas, incluindo a que ⊕4 acrescentou', () => {
    expect(SERIES_DISCONTINUITY_REASONS).toHaveLength(5);
    expect(SERIES_DISCONTINUITY_REASONS).toContain('CURRENCY_REBASED');
  });

  it.each(SERIES_DISCONTINUITY_REASONS)('aceita %s', (reason) => {
    expect(asDiscontinuityReason(reason)).toBe(reason);
    expect(breaksSeries(reason)).toBe(true);
  });

  it('série contínua é `null`, e `null` não quebra nada', () => {
    expect(asDiscontinuityReason(null)).toBeNull();
    expect(breaksSeries(null)).toBe(false);
    expect(breaksSeries(undefined)).toBe(false);
  });

  it('valor fora do vocabulário não corta a série', () => {
    // A coluna é TEXT e nada no banco impede uma string qualquer. Tratar
    // desconhecido como descontinuidade cortaria séries inteiras por causa de um
    // typo; a leitura conservadora é não interromper e deixar o valor visível no
    // log de quem investiga.
    expect(asDiscontinuityReason('QUEBROU')).toBeNull();
    expect(asDiscontinuityReason('UNSPECIFIED')).toBeNull();
    expect(breaksSeries('true')).toBe(false);
  });

  it('string vazia é ausência de motivo, não motivo vazio', () => {
    expect(asDiscontinuityReason('')).toBeNull();
    expect(breaksSeries('')).toBe(false);
  });
});
