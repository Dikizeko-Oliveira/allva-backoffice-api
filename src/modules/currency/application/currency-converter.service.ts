import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import {
  CurrencyNormalizationService,
  startOfUtcDay,
} from '../domain/currency-normalization.service';
import { FxRate } from '../domain/fx-rate';
import { FxRatesRepositoryInterface } from '../domain/ports/fx-rates.repository';

/**
 * O resultado de normalizar um valor — com tudo que a linha precisa gravar.
 *
 * `fxRate`, `fxAsOf` e `fxSource` viajam juntos com o número **de propósito**
 * (M2): converter na leitura faria o desperdício histórico variar todo dia sem
 * nada ter acontecido com o anúncio, e ninguém conseguiria explicar por quê.
 */
export type NormalizedAmount = {
  valueBase: number;
  fxRate: number | null;
  fxAsOf: Date | null;
  fxSource: string | null;
  /** `true` quando a taxa não existia: a linha entra, fora das agregações. */
  normalizationPending: boolean;
};

/**
 * Ponte entre a matemática pura e o banco: carrega as taxas, chama o domínio.
 *
 * É o serviço que os outros módulos injetam. Nenhum deles lê `fx_rates`, e
 * nenhum multiplica dois números por conta própria.
 */
@Injectable()
export class CurrencyConverterService {
  private readonly logger = new Logger(CurrencyConverterService.name);
  private readonly normalization: CurrencyNormalizationService;

  constructor(
    private readonly fxRates: FxRatesRepositoryInterface,
    env: EnvService,
  ) {
    this.normalization = new CurrencyNormalizationService(
      env.get('FX_PIVOT_CURRENCY'),
    );
  }

  /**
   * Normaliza um valor para a moeda-base, usando a taxa **da data do valor**.
   *
   * Taxa ausente não é erro: devolve `normalizationPending`, e quem ingere grava
   * a linha assim mesmo. Bloquear a ingestão por falta de câmbio trocaria um
   * problema de comparabilidade por um buraco permanente na série.
   */
  async normalize(input: {
    amount: number;
    fromCurrency: string;
    toCurrency: string;
    date: Date;
  }): Promise<NormalizedAmount> {
    const { amount, fromCurrency, toCurrency, date } = input;
    const rates = await this.ratesFor([fromCurrency, toCurrency], date);
    const converted = this.normalization.convert(
      amount,
      fromCurrency,
      toCurrency,
      date,
      rates,
    );

    if (!converted) {
      this.logger.warn(
        `fx.rate_unavailable ${fromCurrency}->${toCurrency} em ${startOfUtcDay(date).toISOString().slice(0, 10)} — linha entra com normalizationPending`,
      );
      return {
        valueBase: 0,
        fxRate: null,
        fxAsOf: null,
        fxSource: null,
        normalizationPending: true,
      };
    }

    return {
      valueBase: converted.amount,
      fxRate: converted.rate.rate,
      fxAsOf: converted.rate.asOf,
      fxSource: converted.rate.source,
      normalizationPending: false,
    };
  }

  /**
   * Uma leitura de `fx_rates` para a **janela inteira**, e não uma por linha
   * (A2-S3).
   *
   * O ingest normaliza gasto e receita de cada dia de cada anúncio: numa conta
   * de 5k anúncios com janela de 14 dias são 140 mil conversões. Com uma
   * consulta por conversão, o alvo de < 5 min por conta (§17.2) morre no banco,
   * não na plataforma. A tabela carrega as taxas uma vez e o resto é a mesma
   * função pura de sempre — a regra de §16.10 (só `currency` lê `fx_rates`)
   * continua valendo porque a leitura continua acontecendo aqui.
   */
  async tableFor(input: {
    fromCurrency: string;
    toCurrency: string;
    since: Date;
    until: Date;
  }): Promise<CurrencyRateTable> {
    // Mesma folga de 10 dias do caminho unitário: o carry-forward precisa
    // alcançar a última cotação real antes do início da janela.
    const since = new Date(
      startOfUtcDay(input.since).getTime() - 10 * 24 * 60 * 60 * 1000,
    );

    const rates = await this.fxRates.findRange({
      currencies: [
        ...new Set(
          [input.fromCurrency, input.toCurrency].map((c) => c.toUpperCase()),
        ),
      ],
      since,
      until: startOfUtcDay(input.until),
    });

    return new CurrencyRateTable(
      this.normalization,
      input.fromCurrency,
      input.toCurrency,
      rates,
    );
  }

  /**
   * A janela de leitura é de 10 dias para trás porque o carry-forward só olha
   * para trás: um feriado prolongado precisa alcançar a última cotação real.
   */
  private ratesFor(currencies: string[], date: Date) {
    const until = startOfUtcDay(date);
    const since = new Date(until.getTime() - 10 * 24 * 60 * 60 * 1000);

    return this.fxRates.findRange({
      currencies: [...new Set(currencies.map((c) => c.toUpperCase()))],
      since,
      until,
    });
  }
}

/**
 * As taxas de um par de moedas ao longo de uma janela, já carregadas.
 *
 * Não é cache: é o mesmo conjunto de taxas aplicado a todas as linhas da mesma
 * ingestão, o que também garante que duas linhas do mesmo dia não peguem
 * cotações diferentes por terem sido lidas com milissegundos de diferença.
 */
export class CurrencyRateTable {
  constructor(
    private readonly normalization: CurrencyNormalizationService,
    private readonly fromCurrency: string,
    private readonly toCurrency: string,
    private readonly rates: FxRate[],
  ) {}

  normalize(amount: number, date: Date): NormalizedAmount {
    const converted = this.normalization.convert(
      amount,
      this.fromCurrency,
      this.toCurrency,
      date,
      this.rates,
    );

    if (!converted) {
      return {
        valueBase: 0,
        fxRate: null,
        fxAsOf: null,
        fxSource: null,
        normalizationPending: true,
      };
    }

    return {
      valueBase: converted.amount,
      fxRate: converted.rate.rate,
      fxAsOf: converted.rate.asOf,
      fxSource: converted.rate.source,
      normalizationPending: false,
    };
  }
}
