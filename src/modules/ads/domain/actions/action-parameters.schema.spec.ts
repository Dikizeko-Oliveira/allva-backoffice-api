import { parseActionParameters } from './action-parameters.schema';

/**
 * `REPLACE_COPY` tem duas formas — texto principal (Meta, TikTok) e asset
 * escolhido (Google) — e **exatamente uma por ação**. Aceitar as duas deixaria o
 * gateway escolher qual aplicar; aceitar nenhuma gravaria uma ação sem texto.
 */
describe('parâmetros de REPLACE_COPY', () => {
  const base = { adId: 'ad-1', aiAuthored: true };
  const asset = {
    field: 'HEADLINE',
    index: 0,
    currentValue: 'Aumente suas vendas',
    value: 'Mais ROAS nas suas campanhas',
  };

  /** Toda ação já gravada traz `primaryText`: a adição não pode invalidá-las. */
  it('continua aceitando o texto principal da versão 1', () => {
    expect(
      parseActionParameters('REPLACE_COPY', {
        ...base,
        primaryText: 'Texto principal',
      }),
    ).toMatchObject({ schemaVersion: 1, primaryText: 'Texto principal' });
  });

  it('aceita um asset escolhido', () => {
    expect(
      parseActionParameters('REPLACE_COPY', {
        ...base,
        assetReplacement: asset,
      }),
    ).toMatchObject({ assetReplacement: asset });
  });

  it('recusa os dois alvos ao mesmo tempo', () => {
    expect(() =>
      parseActionParameters('REPLACE_COPY', {
        ...base,
        primaryText: 'Texto principal',
        assetReplacement: asset,
      }),
    ).toThrow();
  });

  it('recusa ação sem alvo de texto', () => {
    expect(() => parseActionParameters('REPLACE_COPY', base)).toThrow();
  });

  it('recusa campo de asset fora de título e descrição', () => {
    expect(() =>
      parseActionParameters('REPLACE_COPY', {
        ...base,
        assetReplacement: { ...asset, field: 'PATH' },
      }),
    ).toThrow();
  });
});
