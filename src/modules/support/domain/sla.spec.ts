import {
  addMinutes,
  FALLBACK_SLA_TARGETS,
  pendingDeadlinesOf,
  resolveSlaTargets,
  SLA_AT_RISK_MAX_WINDOW_MS,
  SLA_AT_RISK_MIN_WINDOW_MS,
  slaAtRiskWindowMs,
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
  const MINUTE = 60_000;
  const at = (offsetMs: number) => new Date(now.getTime() + offsetMs);
  /** Um prazo longo (começou há um dia), cuja janela é o teto de 2 h. */
  const long = (dueOffsetMs: number) => ({
    dueAt: at(dueOffsetMs),
    startedAt: at(-24 * 60 * MINUTE),
  });

  it('prazo vencido é BREACHED, mesmo com outro no futuro', () => {
    expect(
      slaStateOf([long(-1), long(10 * SLA_AT_RISK_MAX_WINDOW_MS)], now),
    ).toBe('BREACHED');
  });

  it('prazo longo vencendo dentro de 2 h é AT_RISK', () => {
    expect(slaStateOf([long(SLA_AT_RISK_MAX_WINDOW_MS)], now)).toBe('AT_RISK');
  });

  it('prazo longo fora das 2 h é ON_TRACK', () => {
    expect(slaStateOf([long(SLA_AT_RISK_MAX_WINDOW_MS + 1)], now)).toBe(
      'ON_TRACK',
    );
  });

  it('sem prazo pendente é ON_TRACK', () => {
    expect(slaStateOf([], now)).toBe('ON_TRACK');
  });

  /**
   * GAP-059: com a janela fixa de 2 h, a primeira resposta de HIGH e de
   * CRITICAL nascia em risco. Cada prioridade, recém-aberta, está no prazo; e
   * entra em risco perto do vencimento da primeira resposta.
   */
  describe.each(Object.entries(FALLBACK_SLA_TARGETS))(
    'chamado %s pelo fallback',
    (_priority, targets) => {
      const openedAt = now;
      const snapshot = (elapsedMs: number) => ({
        status: 'OPEN',
        openedAt,
        dueFirstResponseAt: addMinutes(openedAt, targets.firstResponseMinutes),
        dueResolutionAt: addMinutes(openedAt, targets.resolutionMinutes),
        firstOperatorReplyAt: null,
        clock: new Date(openedAt.getTime() + elapsedMs),
      });
      const stateAt = (elapsedMs: number) => {
        const s = snapshot(elapsedMs);
        return slaStateOf(pendingDeadlinesOf(s), s.clock);
      };
      const firstResponseMs = targets.firstResponseMinutes * MINUTE;
      const windowMs = slaAtRiskWindowMs({
        startedAt: openedAt,
        dueAt: addMinutes(openedAt, targets.firstResponseMinutes),
      });

      it('recém-aberto é ON_TRACK', () => {
        expect(stateAt(0)).toBe('ON_TRACK');
      });

      it('entra em AT_RISK na janela da primeira resposta', () => {
        expect(stateAt(firstResponseMs - windowMs - 1)).toBe('ON_TRACK');
        expect(stateAt(firstResponseMs - windowMs)).toBe('AT_RISK');
      });

      it('passa a BREACHED depois do vencimento', () => {
        expect(stateAt(firstResponseMs + 1)).toBe('BREACHED');
      });
    },
  );
});

describe('slaAtRiskWindowMs', () => {
  const start = new Date('2026-09-23T12:00:00Z');
  const windowFor = (minutes: number) =>
    slaAtRiskWindowMs({ startedAt: start, dueAt: addMinutes(start, minutes) });

  it('é a última quarta parte do prazo', () => {
    expect(windowFor(2 * 60)).toBe(30 * 60_000);
  });

  it('nunca é menor que 10 minutos', () => {
    expect(windowFor(30)).toBe(SLA_AT_RISK_MIN_WINDOW_MS);
  });

  it('nunca passa de 2 horas', () => {
    expect(windowFor(5 * 24 * 60)).toBe(SLA_AT_RISK_MAX_WINDOW_MS);
  });

  it('prazo que vence antes de começar usa o piso', () => {
    expect(windowFor(-5)).toBe(SLA_AT_RISK_MIN_WINDOW_MS);
  });
});

describe('pendingDeadlinesOf', () => {
  const openedAt = new Date('2026-09-23T12:00:00Z');
  const base = {
    status: 'OPEN',
    openedAt,
    dueFirstResponseAt: addMinutes(openedAt, 60),
    dueResolutionAt: addMinutes(openedAt, 600),
    firstOperatorReplyAt: null as Date | null,
  };

  it('vivo e sem resposta: os dois prazos, contados da abertura', () => {
    expect(pendingDeadlinesOf(base)).toEqual([
      { dueAt: base.dueFirstResponseAt, startedAt: openedAt },
      { dueAt: base.dueResolutionAt, startedAt: openedAt },
    ]);
  });

  it('primeira resposta dada: só a resolução', () => {
    expect(
      pendingDeadlinesOf({ ...base, firstOperatorReplyAt: openedAt }),
    ).toEqual([{ dueAt: base.dueResolutionAt, startedAt: openedAt }]);
  });

  it('encerrado: nenhum prazo', () => {
    expect(pendingDeadlinesOf({ ...base, status: 'RESOLVED' })).toEqual([]);
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
