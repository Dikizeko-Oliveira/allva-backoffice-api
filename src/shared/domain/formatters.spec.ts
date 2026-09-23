import {
  formatDateBR,
  formatDateTimeBR,
  formatInteger,
  formatMoneyAmount,
  formatMoneyView,
  formatNumber,
  formatPercent,
} from './formatters';

describe('formatMoneyAmount', () => {
  it('formats a common two-decimal currency in pt-BR', () => {
    expect(formatMoneyAmount(1234.5, 'BRL')).toBe('R$ 1.234,50');
  });

  it('uses zero decimals for a zero-exponent currency (JPY)', () => {
    expect(formatMoneyAmount(5000, 'JPY')).not.toContain(',');
    expect(formatMoneyAmount(5000, 'JPY')).toMatch(/5\.000/);
  });

  it('uses three decimals for a three-exponent currency (BHD)', () => {
    expect(formatMoneyAmount(12.3456, 'BHD')).toMatch(/12,346/);
  });

  it('falls back to a bare number when currency is missing', () => {
    expect(formatMoneyAmount(10, null)).toBe(formatNumber(10));
    expect(formatMoneyAmount(10, undefined)).toBe(formatNumber(10));
    expect(formatMoneyAmount(10, '')).toBe(formatNumber(10));
  });

  it('degrades to "CODE number" instead of throwing on an invalid currency code', () => {
    expect(() => formatMoneyAmount(10, 'XX')).not.toThrow();
    expect(formatMoneyAmount(10, 'not-a-code')).toContain('NOT-A-CODE');
  });

  it('never leaks null, undefined or NaN into the output', () => {
    expect(formatMoneyAmount(null, 'BRL')).toBe('—');
    expect(formatMoneyAmount(undefined, 'BRL')).toBe('—');
    expect(formatMoneyAmount(NaN, 'BRL')).toBe('—');
    expect(formatMoneyAmount(Infinity, 'BRL')).toBe('—');
    expect(formatMoneyAmount(-Infinity, 'BRL')).toBe('—');
  });

  it('formats zero and large values correctly', () => {
    expect(formatMoneyAmount(0, 'BRL')).toContain('0,00');
    expect(formatMoneyAmount(1_234_567.89, 'USD')).toMatch(/1.234.567,89/);
  });

  it('handles negative values', () => {
    expect(formatMoneyAmount(-50, 'BRL')).toContain('-');
  });
});

describe('formatMoneyView', () => {
  it('formats a MoneyView-shaped value', () => {
    expect(formatMoneyView({ valueBase: 10, baseCurrency: 'BRL' })).toContain(
      '10,00',
    );
  });

  it('returns em dash for null/undefined', () => {
    expect(formatMoneyView(null)).toBe('—');
    expect(formatMoneyView(undefined)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('formats with pt-BR grouping and decimals', () => {
    expect(formatNumber(1234.5)).toBe('1.234,50');
  });

  it('never renders NaN as a string', () => {
    expect(formatNumber(NaN)).toBe('—');
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(undefined)).toBe('—');
    expect(formatNumber(Infinity)).toBe('—');
  });

  it('respects a custom decimal count', () => {
    expect(formatNumber(1.005, 0)).toBe('1');
  });
});

describe('formatInteger', () => {
  it('rounds and groups', () => {
    expect(formatInteger(1234.6)).toBe('1.235');
  });

  it('never renders NaN/null/undefined', () => {
    expect(formatInteger(NaN)).toBe('—');
    expect(formatInteger(null)).toBe('—');
    expect(formatInteger(undefined)).toBe('—');
  });

  it('formats zero', () => {
    expect(formatInteger(0)).toBe('0');
  });
});

describe('formatPercent', () => {
  it('formats with a % suffix and one decimal by default', () => {
    expect(formatPercent(12.34)).toBe('12,3%');
  });

  it('signs positive and negative values when requested', () => {
    expect(formatPercent(5, { signed: true })).toBe('+5,0%');
    expect(formatPercent(-5, { signed: true })).toBe('-5,0%');
    expect(formatPercent(0, { signed: true })).toBe('+0,0%');
  });

  it('never renders NaN/null/undefined', () => {
    expect(formatPercent(NaN)).toBe('—');
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(undefined)).toBe('—');
  });
});

describe('formatDateBR / formatDateTimeBR', () => {
  it('formats a valid date as dd/mm/aaaa', () => {
    expect(formatDateBR(new Date('2026-08-27T12:00:00.000Z'))).toBe(
      '27/08/2026',
    );
  });

  it('formats a valid datetime with a time component', () => {
    expect(formatDateTimeBR(new Date('2026-08-27T12:00:00.000Z'))).toMatch(
      /27\/08\/2026 às \d{2}:\d{2}/,
    );
  });

  it('never renders "Invalid Date" for null, undefined or an invalid Date', () => {
    expect(formatDateBR(null)).toBe('—');
    expect(formatDateBR(undefined)).toBe('—');
    expect(formatDateBR(new Date('not-a-date'))).toBe('—');
    expect(formatDateTimeBR(null)).toBe('—');
    expect(formatDateTimeBR(new Date('not-a-date'))).toBe('—');
  });
});
