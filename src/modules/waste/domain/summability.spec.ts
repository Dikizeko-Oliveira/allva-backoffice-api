import { rollupForAd, type SummableFinding } from './summability';

/**
 * §10.6 — **o gate mais importante deste sprint, no eixo do tipo.**
 *
 * A dupla contagem que motivou a v2.0 inteira era no eixo do **nível**: o mesmo
 * gasto guardado em campanha, conjunto, anúncio e criativo, somado quatro vezes.
 * Ela reaparece no eixo do **achado** se o total do anúncio somar tipos — e o
 * segundo caso é mais insidioso, porque cada parcela é verdadeira isolada.
 */

const finding = (
  type: SummableFinding['type'],
  incurredBase: number,
  avoidableBase: number,
): SummableFinding => ({
  type,
  incurred: { value: incurredBase, valueBase: incurredBase },
  avoidableDaily: { value: avoidableBase, valueBase: avoidableBase },
});

describe('somabilidade por anúncio (§10.6)', () => {
  it('entre tipos, o total é o MÁXIMO — nunca a soma', () => {
    const rollup = rollupForAd([
      finding('ZERO_CONVERSIONS', 1_000, 70),
      finding('LOW_CTR', 400, 30),
      finding('CREATIVE_FATIGUE', 250, 20),
    ]);

    // Um anúncio com três achados desperdiçou **um** gasto, não três. A soma
    // (1.650) contaria o mesmo dinheiro três vezes no eixo do tipo.
    expect(rollup.incurred.valueBase).toBe(1_000);
    // E pausá-lo resolve os três de uma vez — por isso o evitável também é o
    // máximo: a ação não interrompe 120 por dia, interrompe 70.
    expect(rollup.avoidableDaily.valueBase).toBe(70);
    expect(rollup.openWasteCount).toBe(3);
  });

  it('oportunidade nunca entra em total de desperdício', () => {
    const rollup = rollupForAd([
      finding('ZERO_CONVERSIONS', 100, 10),
      // Um `BUDGET_STARVATION` com evitável enorme: se ele entrasse, o número
      // de capa diria que há 900/dia de desperdício num anúncio saudável.
      finding('BUDGET_STARVATION', 0, 900),
    ]);

    expect(rollup.avoidableDaily.valueBase).toBe(10);
    expect(rollup.incurred.valueBase).toBe(100);
    // A contagem também é só de desperdício: `openWasteCount` alimenta o filtro
    // `hasOpenWaste` de `GET /ads`, e uma oportunidade ali faria a tela de
    // problemas listar um anúncio que não tem nenhum.
    expect(rollup.openWasteCount).toBe(1);
  });

  it('anúncio sem achado zera as colunas em vez de preservá-las', () => {
    // Sem isto, um anúncio que deixou de ter desperdício continuaria exibindo o
    // número da última vez que teve — dinheiro queimando num anúncio limpo.
    expect(rollupForAd([])).toEqual({
      openWasteCount: 0,
      incurred: { value: 0, valueBase: 0 },
      avoidableDaily: { value: 0, valueBase: 0 },
    });
  });

  it('as duas moedas são maximizadas independentemente', () => {
    const rollup = rollupForAd([
      {
        type: 'ZERO_CONVERSIONS',
        incurred: { value: 200, valueBase: 1_000 },
        avoidableDaily: { value: 14, valueBase: 70 },
      },
      {
        type: 'LOW_CTR',
        incurred: { value: 80, valueBase: 400 },
        avoidableDaily: { value: 6, valueBase: 30 },
      },
    ]);

    expect(rollup.incurred).toEqual({ value: 200, valueBase: 1_000 });
    expect(rollup.avoidableDaily).toEqual({ value: 14, valueBase: 70 });
  });
});
