import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { FxRate } from '../domain/fx-rate';
import { FxRatesRepositoryInterface } from '../domain/ports/fx-rates.repository';
import { CurrencyConverterService } from './currency-converter.service';

function buildHarness(rates: FxRate[]) {
  const findRange = jest.fn().mockResolvedValue(rates);
  const repository = { findRange } as unknown as FxRatesRepositoryInterface;
  const env = { get: () => 'USD' } as unknown as EnvService;

  return {
    service: new CurrencyConverterService(repository, env),
    findRange,
  };
}

const RATE: FxRate = {
  date: new Date('2026-07-28T00:00:00.000Z'),
  fromCurrency: 'USD',
  toCurrency: 'BRL',
  rate: 5.5,
  source: 'vendor-x',
};

const DAY = new Date('2026-07-28T00:00:00.000Z');

describe('CurrencyConverterService', () => {
  it('normaliza e devolve a procedência da taxa junto do número (M2)', async () => {
    const h = buildHarness([RATE]);

    const result = await h.service.normalize({
      amount: 1240,
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      date: DAY,
    });

    expect(result).toEqual({
      valueBase: 6820,
      fxRate: 5.5,
      fxAsOf: DAY,
      fxSource: 'vendor-x',
      normalizationPending: false,
    });
  });

  /**
   * O gate de saída de A2-S1, em uma asserção: **taxa indisponível não bloqueia
   * a ingestão**. A linha entra marcada como pendente, fica fora das agregações
   * de inteligência (M1) e reduz a evidência declarada — perder a
   * comparabilidade do dia é ruim, perder o dado do dia é irreversível.
   */
  it('marca normalizationPending quando não há taxa, sem lançar', async () => {
    const h = buildHarness([]);

    const result = await h.service.normalize({
      amount: 1240,
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      date: DAY,
    });

    expect(result).toEqual({
      valueBase: 0,
      fxRate: null,
      fxAsOf: null,
      fxSource: null,
      normalizationPending: true,
    });
  });

  it('lê uma janela para trás, porque o carry-forward só olha para trás', async () => {
    const h = buildHarness([RATE]);

    await h.service.normalize({
      amount: 10,
      fromCurrency: 'USD',
      toCurrency: 'BRL',
      date: DAY,
    });

    const [query] = h.findRange.mock.calls[0];
    expect(query.until.getTime()).toBe(DAY.getTime());
    // Feriado prolongado precisa alcançar a última cotação real.
    expect(query.since.getTime()).toBeLessThan(DAY.getTime());
    expect(query.currencies).toEqual(['USD', 'BRL']);
  });

  it('não consulta câmbio quando a moeda da conta é a moeda-base', async () => {
    const h = buildHarness([]);

    const result = await h.service.normalize({
      amount: 500,
      fromCurrency: 'BRL',
      toCurrency: 'BRL',
      date: DAY,
    });

    expect(result.valueBase).toBe(500);
    expect(result.normalizationPending).toBe(false);
    expect(result.fxRate).toBe(1);
  });
});
