import { generatedCopySchema } from './copy-generation.schema';

/**
 * As tolerâncias do envelope de saída — **cada uma nasceu de uma falha real**.
 *
 * Na primeira execução contra provedores reais, as três chamadas da rota
 * (`claude-sonnet-5`, `claude-haiku-4-5`, `gpt-5.6-luna`) foram recusadas na
 * fronteira com *"variants: expected array, received undefined"*. O schema
 * estava certo e o prompt não declarava o formato — o modelo acertava o
 * conteúdo e errava o invólucro.
 *
 * A correção principal foi declarar o contrato no prompt. Estas asserções
 * cobrem o que resta: as formas que um modelo devolve **mesmo instruído**, e
 * que não valem uma segunda chamada paga para reaprender.
 *
 * O que continua estrito é `angle`. Sem ele a variação não é um ângulo, e o
 * ângulo é a feature: uma resposta sem ele é errada, não incompleta.
 */

const variant = {
  angle: 'BENEFIT',
  hook: 'Pare de perder horas.',
  primaryText: 'Pare de perder horas analisando campanhas manualmente.',
  headline: 'Menos trabalho manual',
  description: 'Em uma tela',
  callToAction: 'SHOP_NOW',
  reasoning: [
    { claim: 'Hook mais específico', addressesSuggestion: 'WEAK_HOOK' },
  ],
};

describe('envelope da geração — as formas que o modelo devolve', () => {
  it('aceita a forma pedida', () => {
    const parsed = generatedCopySchema.parse({ variants: [variant] });

    expect(parsed.variants).toHaveLength(1);
    expect(parsed.variants[0].callToAction).toBe('SHOP_NOW');
  });

  it('aceita a lista nua no topo, sem o objeto envolvente', () => {
    // O desvio comum quando a instrução pede "três variações". Recusá-lo
    // gastaria uma chamada do modelo mais caro do catálogo.
    const parsed = generatedCopySchema.parse([variant]);

    expect(parsed.variants).toHaveLength(1);
  });

  it('aceita campo de texto omitido e o normaliza para null', () => {
    // Modelo omite o que é nulo, mesmo instruído a não omitir. A variação
    // continua correta em tudo o que importa.
    const parsed = generatedCopySchema.parse({
      variants: [{ angle: 'PAIN', primaryText: 'Texto', reasoning: [] }],
    });

    expect(parsed.variants[0].headline).toBeNull();
    expect(parsed.variants[0].hook).toBeNull();
    expect(parsed.variants[0].callToAction).toBeNull();
  });

  it('aceita `reasoning` ausente e o normaliza para lista vazia', () => {
    const parsed = generatedCopySchema.parse({
      variants: [{ angle: 'OUTCOME', primaryText: 'Texto' }],
    });

    expect(parsed.variants[0].reasoning).toEqual([]);
  });

  it('normaliza `addressesSuggestion` ausente para null', () => {
    // `null` ali significa "veio do modelo, não da análise" — e a tela usa isso
    // para não creditar à Allva o que ela não sugeriu. `undefined` faria a
    // distinção depender de quem lê.
    const parsed = generatedCopySchema.parse({
      variants: [
        {
          angle: 'PROOF',
          primaryText: 'Texto',
          reasoning: [{ claim: 'algo' }],
        },
      ],
    });

    expect(parsed.variants[0].reasoning[0].addressesSuggestion).toBeNull();
  });
});

describe('envelope da geração — o que continua sendo recusado', () => {
  it('recusa variação sem ângulo', () => {
    expect(() =>
      generatedCopySchema.parse({ variants: [{ primaryText: 'Texto' }] }),
    ).toThrow();
  });

  it('recusa ângulo fora do conjunto', () => {
    expect(() =>
      generatedCopySchema.parse({
        variants: [{ angle: 'FUNNY', primaryText: 'Texto' }],
      }),
    ).toThrow();
  });

  it('recusa lista vazia — geração sem variação não é resposta', () => {
    expect(() => generatedCopySchema.parse({ variants: [] })).toThrow();
  });

  it('recusa objeto sem `variants` nem lista', () => {
    expect(() => generatedCopySchema.parse({ copies: [variant] })).toThrow();
  });
});
