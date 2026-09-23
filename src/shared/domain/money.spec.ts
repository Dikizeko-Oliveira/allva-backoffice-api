import { currencyExponent, fromMinorUnits, toMinorUnits } from './money';

/**
 * O teste existe porque este é o ponto onde um erro de formato vira dinheiro
 * real. Ler errado mostra um número errado; escrever errado **gasta** errado, e
 * a diferença entre as duas é a razão de A2-S7 ter dry-run obrigatório.
 */
describe('unidade menor por moeda (ISO 4217)', () => {
  it('usa duas casas para as moedas comuns', () => {
    expect(currencyExponent('BRL')).toBe(2);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('eur')).toBe(2);
  });

  it('reconhece as moedas sem casa decimal', () => {
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('CLP')).toBe(0);
  });

  it('reconhece as moedas de três casas', () => {
    expect(currencyExponent('KWD')).toBe(3);
    expect(currencyExponent('BHD')).toBe(3);
  });

  /**
   * O caso que motivou tudo: ¥50.000 é `50000` para a Meta, não `5000000`.
   * Multiplicar por 100 aqui aprovaria um orçamento cem vezes maior que o
   * confirmado pelo usuário.
   */
  it('não inventa centavos onde a moeda não tem', () => {
    expect(toMinorUnits(50_000, 'JPY')).toBe('50000');
    expect(toMinorUnits(150.5, 'BRL')).toBe('15050');
    expect(toMinorUnits(1.5, 'KWD')).toBe('1500');
  });

  /**
   * `150.55 * 100` é `15054.999999999998` em ponto flutuante. Truncar mandaria
   * 15054 — um centavo a menos a cada escrita, para sempre.
   */
  it('arredonda em vez de truncar o resíduo binário', () => {
    expect(toMinorUnits(150.55, 'BRL')).toBe('15055');
    expect(toMinorUnits(0.29, 'USD')).toBe('29');
  });

  it('volta da unidade menor pela mesma régua', () => {
    expect(fromMinorUnits('15050', 'BRL')).toBe(150.5);
    expect(fromMinorUnits('50000', 'JPY')).toBe(50_000);
    expect(fromMinorUnits(1500, 'KWD')).toBe(1.5);
  });

  it('trata ausência como ausência, não como zero', () => {
    // Zero é um orçamento; ausente é "a plataforma não informou". Colapsar os
    // dois faria um ad set sem orçamento próprio parecer um ad set com R$ 0.
    expect(fromMinorUnits(null, 'BRL')).toBeNull();
    expect(fromMinorUnits(undefined, 'BRL')).toBeNull();
    expect(fromMinorUnits('', 'BRL')).toBeNull();
    expect(fromMinorUnits('não-é-número', 'BRL')).toBeNull();
    expect(fromMinorUnits('0', 'BRL')).toBe(0);
  });

  it('faz a ida e a volta sem perder valor', () => {
    for (const [amount, currency] of [
      [1234.56, 'BRL'],
      [99, 'JPY'],
      [0.01, 'USD'],
      [12.345, 'KWD'],
    ] as const) {
      expect(fromMinorUnits(toMinorUnits(amount, currency), currency)).toBe(
        amount,
      );
    }
  });
});
