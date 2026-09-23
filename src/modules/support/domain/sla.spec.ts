import {
  FALLBACK_SLA_TARGETS,
  resolveSlaTargets,
  SLA_AT_RISK_WINDOW_MS,
  slaStateOf,
  slaUrgencyOrder,
} from './sla';

const policy = (
  overrides: Partial<Parameters<typeof resolveSlaTargets>[0][number]>,
) => ({
  priority: 'HIGH',
  category: null,
  active: true,
  firstResponseMinutes: 60,
  resolutionMinutes: 600,
  ...overrides,
});

describe('resolveSlaTargets', () => {
  it('prefere a política da categoria à genérica da prioridade', () => {
    const targets = resolveSlaTargets(
      [
        policy({ firstResponseMinutes: 60 }),
        policy({ category: 'BILLING', firstResponseMinutes: 15 }),
      ],
      'HIGH',
      'BILLING',
    );

    expect(targets.firstResponseMinutes).toBe(15);
  });

  it('cai na genérica quando a categoria não tem política', () => {
    const targets = resolveSlaTargets(
      [policy({ category: 'BILLING', firstResponseMinutes: 15 }), policy({})],
      'HIGH',
      'TECHNICAL',
    );

    expect(targets.firstResponseMinutes).toBe(60);
  });

  it('ignora política inativa e usa o fallback da prioridade', () => {
    const targets = resolveSlaTargets(
      [policy({ active: false })],
      'HIGH',
      null,
    );

    expect(targets).toEqual(FALLBACK_SLA_TARGETS.HIGH);
  });

  it('prioridade desconhecida usa o fallback de MEDIUM', () => {
    expect(resolveSlaTargets([], 'URGENTISSIMO', null)).toEqual(
      FALLBACK_SLA_TARGETS.MEDIUM,
    );
  });
});

describe('slaStateOf', () => {
  const now = new Date('2026-09-23T12:00:00Z');
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);

  it('prazo vencido é BREACHED, mesmo com outro no futuro', () => {
    expect(slaStateOf([at(-1), at(10 * SLA_AT_RISK_WINDOW_MS)], now)).toBe(
      'BREACHED',
    );
  });

  it('vence dentro da janela é AT_RISK', () => {
    expect(slaStateOf([at(SLA_AT_RISK_WINDOW_MS)], now)).toBe('AT_RISK');
  });

  it('fora da janela é ON_TRACK', () => {
    expect(slaStateOf([at(SLA_AT_RISK_WINDOW_MS + 1)], now)).toBe('ON_TRACK');
  });

  it('sem prazo pendente é ON_TRACK', () => {
    expect(slaStateOf([], now)).toBe('ON_TRACK');
  });
});

describe('slaUrgencyOrder', () => {
  it('ordena estourado, em risco, no prazo', () => {
    const states = ['ON_TRACK', 'BREACHED', 'AT_RISK'] as const;

    expect(
      [...states].sort((a, b) => slaUrgencyOrder(a) - slaUrgencyOrder(b)),
    ).toEqual(['BREACHED', 'AT_RISK', 'ON_TRACK']);
  });
});
