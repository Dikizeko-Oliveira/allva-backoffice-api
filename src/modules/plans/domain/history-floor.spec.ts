import { historyFloor, planQuota } from './plan-entitlements';
import { resolvePlanFeatures } from './plan-catalog';

const NOW = new Date('2026-08-21T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function daysBack(floor: Date | null): number | null {
  return floor === null
    ? null
    : Math.round((NOW.getTime() - floor.getTime()) / DAY);
}

describe('até onde cada plano lê o próprio histórico', () => {
  it('Individual alcança três meses', () => {
    expect(daysBack(historyFloor('STARTER', NOW))).toBe(90);
  });

  it('Profissional e Enterprise alcançam treze meses', () => {
    expect(daysBack(historyFloor('PRO', NOW))).toBe(395);
    expect(daysBack(historyFloor('ENTERPRISE', NOW))).toBe(395);
  });

  it('o teste gratuito alcança o mesmo que o Profissional', () => {
    expect(daysBack(historyFloor('FREE', NOW))).toBe(
      daysBack(historyFloor('PRO', NOW)),
    );
  });

  it('plano irresolúvel NÃO corta — abre na dúvida', () => {
    /**
     * Assimetria deliberada contra `planAllows`, que fecha. Cortar histórico por
     * não saber o plano faria a tela mostrar uma série truncada como se fosse a
     * série real, e o usuário concluiria queda de desempenho onde houve limite.
     * O erro do lado permissivo é uma leitura a mais; do outro, é um número errado.
     */
    expect(historyFloor(null, NOW)).toBeNull();
    expect(historyFloor(undefined, NOW)).toBeNull();
  });
});

describe('o piso concorda com a vitrine', () => {
  it.each([
    ['STARTER', '3 meses', 90],
    ['PRO', '13 meses', 395],
    ['ENTERPRISE', '13 meses', 395],
  ] as const)('%s mostra "%s" e aplica %i dias', (type, display, days) => {
    const shown = resolvePlanFeatures(type).find(
      (feature) => feature.key === 'data-history',
    )!;

    expect(shown.value).toBe(display);
    expect(planQuota(type, 'data-history')).toBe(days);
  });

  it('a retenção global continua acima do maior piso', () => {
    // 13 meses de retenção (`RETENTION_MONTHS`) é o que o Profissional lê. Um
    // piso maior que a retenção prometeria histórico que já foi podado.
    expect(planQuota('PRO', 'data-history')).toBeLessThanOrEqual(13 * 30 + 5);
  });
});
