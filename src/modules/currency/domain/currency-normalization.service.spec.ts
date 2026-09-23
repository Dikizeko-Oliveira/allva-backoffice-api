import {
  CurrencyNormalizationService,
  round,
} from './currency-normalization.service';
import { FxRate } from './fx-rate';

const PIVOT = 'USD';

function rate(
  toCurrency: string,
  day: string,
  value: number,
  source = 'vendor-x',
): FxRate {
  return {
    date: new Date(`${day}T00:00:00.000Z`),
    fromCurrency: PIVOT,
    toCurrency,
    rate: value,
    source,
  };
}

const RATES: FxRate[] = [
  rate('BRL', '2026-07-27', 5.4),
  rate('BRL', '2026-07-28', 5.5),
  rate('EUR', '2026-07-28', 0.9),
];

const service = new CurrencyNormalizationService(PIVOT);
const DAY = new Date('2026-07-28T00:00:00.000Z');

describe('CurrencyNormalizationService.resolve', () => {
  it('devolve 1 para a mesma moeda, sem consultar taxa nenhuma', () => {
    // Uma conta em BRL numa organização em BRL não pode depender de o vendor
    // ter respondido hoje.
    expect(service.resolve('BRL', 'BRL', DAY, [])).toEqual({
      rate: 1,
      asOf: DAY,
      source: 'identity',
      carriedForward: false,
    });
  });

  it('lê a taxa direta quando a origem é o pivô', () => {
    expect(service.resolve('USD', 'BRL', DAY, RATES)).toMatchObject({
      rate: 5.5,
      source: 'vendor-x',
      carriedForward: false,
    });
  });

  it('inverte a taxa quando o destino é o pivô', () => {
    const resolved = service.resolve('BRL', 'USD', DAY, RATES);

    expect(resolved?.rate).toBeCloseTo(1 / 5.5, 10);
  });

  it('deriva par sem pivô por taxa cruzada', () => {
    // EUR→BRL = (USD→BRL) / (USD→EUR) = 5,5 / 0,9.
    const resolved = service.resolve('EUR', 'BRL', DAY, RATES);

    expect(resolved?.rate).toBeCloseTo(5.5 / 0.9, 10);
    expect(resolved?.source).toContain('cross');
  });

  it('é simétrico: converter e desconverter volta ao valor original', () => {
    // O que a coleta contra o pivô existe para garantir. Coletar par a par faria
    // as duas direções divergirem por arredondamento.
    const forward = service.resolve('EUR', 'BRL', DAY, RATES)!;
    const backward = service.resolve('BRL', 'EUR', DAY, RATES)!;

    expect(forward.rate * backward.rate).toBeCloseTo(1, 10);
  });
});

describe('carry-forward (D19)', () => {
  it('usa a última cotação anterior quando o dia não tem taxa', () => {
    // 29/07 não tem cotação: fim de semana e feriado não têm, e o dado de mídia
    // tem. Arrastar a última conhecida para frente é a convenção do mercado.
    const resolved = service.resolve(
      'USD',
      'BRL',
      new Date('2026-07-29T00:00:00.000Z'),
      RATES,
    );

    expect(resolved).toMatchObject({ rate: 5.5, carriedForward: true });
    expect(resolved?.source).toBe('vendor-x:carry-forward');
    // A data reportada é a da taxa USADA, não a pedida: é até onde a evidência
    // de fato alcança (P7).
    expect(resolved?.asOf.toISOString()).toBe('2026-07-28T00:00:00.000Z');
  });

  it('nunca extrapola: taxa futura não vale para data passada', () => {
    // Usar a cotação de 28/07 para 26/07 reescreveria o passado com informação
    // que não existia nele — exatamente o que M2 proíbe.
    expect(
      service.resolve(
        'USD',
        'BRL',
        new Date('2026-07-26T00:00:00.000Z'),
        RATES,
      ),
    ).toBeNull();
  });

  it('marca a cruzada como carregada se qualquer das pernas foi', () => {
    const resolved = service.resolve(
      'EUR',
      'BRL',
      new Date('2026-07-30T00:00:00.000Z'),
      RATES,
    );

    expect(resolved?.carriedForward).toBe(true);
    expect(resolved?.source).toContain('carry-forward');
  });
});

describe('convert', () => {
  it('converte e arredonda em 4 casas, como a coluna Decimal(14,4)', () => {
    const converted = service.convert(1240, 'USD', 'BRL', DAY, RATES);

    expect(converted?.amount).toBe(6820);
    expect(converted?.rate.rate).toBe(5.5);
  });

  it('devolve null quando a taxa não existe — quem chama grava pendente', () => {
    // Taxa indisponível nunca bloqueia a ingestão: perder o dado do dia é pior
    // que perder a comparabilidade dele.
    expect(service.convert(100, 'JPY', 'BRL', DAY, RATES)).toBeNull();
  });

  it('preserva o zero sem inventar taxa', () => {
    expect(service.convert(0, 'USD', 'BRL', DAY, RATES)?.amount).toBe(0);
  });
});

describe('round', () => {
  it('arredonda half-up sem herdar o erro de ponto flutuante', () => {
    // `Math.round(1.005 * 100) / 100` devolve 1 em JS. Aqui não.
    expect(round(1.00005, 4)).toBe(1.0001);
    expect(round(6819.99994)).toBe(6819.9999);
    expect(round(-1.00005, 4)).toBe(-1);
  });
});
