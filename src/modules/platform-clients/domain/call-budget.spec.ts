import {
  INSIGHTS_PAGE_SIZE,
  evaluateReachBudget,
  fullSyncCost,
  reachSevenDayCost,
  type AccountShape,
} from './call-budget';

/**
 * **A entrega condicional do plano, avaliada** (A2-S9 entrega 9, DEC-4).
 *
 * A2-S8 transferiu a chamada de reach de 7 dias para A2-S9 com a condição
 * intacta: *"se o orçamento de R4 comportar"*. A nota de então dizia que seria
 * "+1 chamada por conjunto por ciclo, e o custo escala com a estrutura da conta,
 * não com o número de anúncios".
 *
 * **Esse número está errado, e é o que este arquivo estabelece.** A Graph API
 * aceita insights no nível de conta com `level=adset`, `time_range` de 7 dias e
 * **sem** `time_increment` — a resposta é uma linha por conjunto, paginada a
 * 500. O custo não é "uma chamada por conjunto": é uma chamada por conta, até
 * 500 conjuntos.
 *
 * A rajada do balde é 20 (`PlatformRateLimiterService`), e os cenários abaixo
 * são as formas de conta que o produto atende.
 */

function shape(overrides: Partial<AccountShape> = {}): AccountShape {
  return { ads: 220, adSets: 40, restatementWindowDays: 14, ...overrides };
}

const BURST = 20;

describe('o custo de um ciclo, hoje', () => {
  it('insights são pedidos no nível da CONTA, então o custo é sublinear', () => {
    // 220 anúncios × 14 dias = 3.080 linhas ⇒ 7 páginas. Não 220 chamadas.
    const cost = fullSyncCost(shape());

    expect(cost.insightsPages).toBe(7);
    expect(cost.total).toBe(11);
  });

  it('a janela de re-declaração é o multiplicador, não a quantidade de anúncios', () => {
    // Uma conta de 28 dias de atribuição lê o dobro de linhas com os mesmos ads.
    const curta = fullSyncCost(shape({ restatementWindowDays: 7 }));
    const longa = fullSyncCost(shape({ restatementWindowDays: 28 }));

    expect(longa.insightsPages).toBeGreaterThan(curta.insightsPages);
  });
});

describe('o custo incremental do reach de 7 dias (DEC-4)', () => {
  it('é UMA chamada para toda conta com até 500 conjuntos', () => {
    expect(reachSevenDayCost(shape({ adSets: 40 }))).toBe(1);
    expect(reachSevenDayCost(shape({ adSets: INSIGHTS_PAGE_SIZE }))).toBe(1);
    expect(reachSevenDayCost(shape({ adSets: 501 }))).toBe(2);
  });
});

describe('a condição de R4, avaliada', () => {
  /**
   * O critério é a **rajada**, não a taxa: um ciclo dispara as chamadas em
   * sequência, e o que decide se ele é cortado é quantos tokens o balde tem no
   * instante em que começa. A taxa de 5/s repõe o balde inteiro em 4 segundos.
   */
  it('conta típica: cabe com folga', () => {
    const verdict = evaluateReachBudget({
      shape: shape(),
      burstCapacity: BURST,
    });

    expect(verdict.incremental).toBe(1);
    expect(verdict.projected).toBe(12);
    expect(verdict.fits).toBe(true);
    expect(verdict.burstUtilization).toBeLessThan(0.7);
  });

  it('conta grande do seed (5.000 anúncios): NÃO cabe, e já não cabia', () => {
    // 5.000 × 14 = 70.000 linhas ⇒ 140 páginas, contra rajada de 20. O ciclo
    // **já** é fatiado pelo balde hoje, e a chamada de reach acrescenta 1 a 140.
    const grande = shape({ ads: 5_000, adSets: 300 });
    const verdict = evaluateReachBudget({
      shape: grande,
      burstCapacity: BURST,
    });

    expect(verdict.current).toBe(144);
    expect(verdict.incremental).toBe(1);
    expect(verdict.fits).toBe(false);
  });

  /**
   * **O número que decide, e a forma honesta de dizê-lo.**
   *
   * A primeira redação deste teste afirmava "menos de 1% do custo do ciclo em
   * qualquer conta", e ele reprovou: numa conta de 50 anúncios o ciclo inteiro
   * são 6 chamadas, e 1 em 7 é 14%. A fração é a métrica errada — numa conta
   * pequena qualquer coisa é uma fração grande de pouco.
   *
   * O que é verdade em toda forma de conta é o **absoluto**: uma chamada a mais
   * por ciclo, até 500 conjuntos. A condição de DEC-4 é sobre o orçamento
   * comportar essa chamada, e a resposta aritmética é sim. O que **não** é
   * aritmético é a outra metade da entrega — ver o registro em PLAN.md.
   */
  it('o incremento é UMA chamada por ciclo, em qualquer forma de conta', () => {
    const formas = [
      shape({ ads: 50, adSets: 10 }),
      shape(),
      shape({ ads: 1_000, adSets: 120 }),
      shape({ ads: 5_000, adSets: 300, restatementWindowDays: 28 }),
    ];

    for (const forma of formas) {
      const verdict = evaluateReachBudget({
        shape: forma,
        burstCapacity: BURST,
      });

      expect(verdict.incremental).toBe(1);
      expect(verdict.projected - verdict.current).toBe(1);
    }
  });
});
