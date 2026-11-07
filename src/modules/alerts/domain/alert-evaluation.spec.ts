import { decideAlertRule, parseAlertThreshold } from './alert-evaluation';

describe('parseAlertThreshold', () => {
  it.each([
    ['>= 3', 3, true],
    ['>= 3', 2, false],
    ['count >= 1', 1, true],
    ['> 0', 0, false],
    ['> 0', 1, true],
    ['== 2', 2, true],
    ['= 2', 3, false],
  ])('%s com %i é %s', (threshold, count, expected) => {
    expect(parseAlertThreshold(threshold)?.(count)).toBe(expected);
  });

  it.each(['', 'muitos', '>= -1', '>= 1.5', '< 3', '>= 3 or 1'])(
    '%p não é limiar',
    (threshold) => {
      expect(parseAlertThreshold(threshold)).toBeNull();
    },
  );
});

/** GAP-044: quando uma regra dispara. */
describe('decideAlertRule', () => {
  const base = {
    source: 'support.sla_breached',
    threshold: '>= 1',
    count: 2,
    hasOpenEvent: false,
  };

  it('acima do limiar e sem evento aberto dispara, com a severidade do sinal', () => {
    expect(decideAlertRule(base)).toEqual({
      kind: 'FIRE',
      severity: 'CRITICAL',
      count: 2,
    });
  });

  it('evento aberto segura o disparo', () => {
    expect(decideAlertRule({ ...base, hasOpenEvent: true }).kind).toBe(
      'HOLD_OPEN_EVENT',
    );
  });

  it('abaixo do limiar não dispara', () => {
    expect(decideAlertRule({ ...base, count: 0 }).kind).toBe('BELOW_THRESHOLD');
  });

  it('sinal do produto não é avaliado aqui', () => {
    expect(
      decideAlertRule({ ...base, source: 'billing.invoices_overdue' }),
    ).toEqual({ kind: 'NOT_EVALUATED', reason: 'SOURCE_NOT_LOCAL' });
  });

  it('o sinal que depende do operador não é avaliado pelo job', () => {
    expect(
      decideAlertRule({ ...base, source: 'support.assigned_to_me_waiting' })
        .kind,
    ).toBe('NOT_EVALUATED');
  });

  it('limiar ilegível não dispara', () => {
    expect(decideAlertRule({ ...base, threshold: 'muitos' })).toEqual({
      kind: 'NOT_EVALUATED',
      reason: 'THRESHOLD_UNPARSEABLE',
    });
  });

  it('contagem indisponível não dispara nem zera', () => {
    expect(decideAlertRule({ ...base, count: undefined })).toEqual({
      kind: 'NOT_EVALUATED',
      reason: 'SIGNAL_UNAVAILABLE',
    });
  });
});
