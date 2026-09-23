import { Injectable, Logger } from '@nestjs/common';
import { FxRate } from 'src/modules/currency/domain/fx-rate';
import { FxRateProviderInterface } from 'src/modules/currency/domain/ports/fx-rate.provider';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/** Teto por requisição: o job tem lease de 60 min e faz várias janelas. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Provedores de câmbio cobram e limitam por intervalo, então a janela de 400
 * dias do backfill é fatiada. 60 dias cabe folgado no plano gratuito da maioria.
 */
export const MAX_DAYS_PER_REQUEST = 60;

type TimeframeResponse = {
  rates?: Record<string, Record<string, number>>;
  success?: boolean;
  error?: { info?: string; type?: string };
};

/**
 * Provedor de câmbio sobre HTTP, no formato "timeframe" (`exchangerate.host`,
 * `apilayer`, `fixer` — todos respondem `{ rates: { data: { moeda: taxa } } }`).
 *
 * O vendor é configurável por env porque a escolha é comercial, não
 * arquitetural: o que o domínio exige é **histórico por data** (D19), e qualquer
 * um que o entregue serve. Sem `FX_PROVIDER_BASE_URL`, `isConfigured()` devolve
 * `false` e o job registra a degradação em vez de tentar e falhar em silêncio.
 */
@Injectable()
export class HttpFxRateProvider extends FxRateProviderInterface {
  private readonly logger = new Logger(HttpFxRateProvider.name);

  constructor(private readonly env: EnvService) {
    super();
  }

  get source(): string {
    return this.env.get('FX_PROVIDER') ?? 'http';
  }

  isConfigured(): boolean {
    return Boolean(this.env.get('FX_PROVIDER_BASE_URL'));
  }

  async getHistorical(input: {
    pivotCurrency: string;
    currencies: string[];
    since: Date;
    until: Date;
  }): Promise<FxRate[]> {
    if (!this.isConfigured()) return [];

    const symbols = input.currencies
      .map((currency) => currency.toUpperCase())
      .filter((currency) => currency !== input.pivotCurrency.toUpperCase());

    if (symbols.length === 0) return [];

    const collected: FxRate[] = [];
    for (const window of splitWindows(input.since, input.until)) {
      collected.push(
        ...(await this.fetchWindow({
          pivotCurrency: input.pivotCurrency,
          symbols,
          ...window,
        })),
      );
    }

    return collected;
  }

  private async fetchWindow(input: {
    pivotCurrency: string;
    symbols: string[];
    since: Date;
    until: Date;
  }): Promise<FxRate[]> {
    const base = (this.env.get('FX_PROVIDER_BASE_URL') ?? '').replace(
      /\/$/,
      '',
    );
    const url = new URL(`${base}/timeframe`);
    url.searchParams.set('start_date', isoDate(input.since));
    url.searchParams.set('end_date', isoDate(input.until));
    url.searchParams.set('base', input.pivotCurrency.toUpperCase());
    url.searchParams.set('symbols', input.symbols.join(','));

    const apiKey = this.env.get('FX_PROVIDER_API_KEY');
    if (apiKey) url.searchParams.set('access_key', apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        this.logger.warn(
          `fx.provider_http_error status=${response.status} janela=${isoDate(input.since)}..${isoDate(input.until)}`,
        );
        return [];
      }

      const body = (await response.json()) as TimeframeResponse;
      if (body.success === false) {
        this.logger.warn(
          `fx.provider_error ${body.error?.info ?? 'sem detalhe'}`,
        );
        return [];
      }

      return this.toRates(body, input.pivotCurrency);
    } catch (error) {
      // Falha de câmbio degrada a normalização; nunca derruba quem chamou.
      this.logger.warn(
        `fx.provider_unreachable ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private toRates(body: TimeframeResponse, pivotCurrency: string): FxRate[] {
    const rates: FxRate[] = [];

    for (const [day, quotes] of Object.entries(body.rates ?? {})) {
      const date = new Date(`${day}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime())) continue;

      for (const [currency, rate] of Object.entries(quotes)) {
        if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
          continue;
        }
        rates.push({
          date,
          fromCurrency: pivotCurrency.toUpperCase(),
          toCurrency: currency.toUpperCase(),
          rate,
          source: this.source,
        });
      }
    }

    return rates;
  }
}

/** Fatia o intervalo em janelas que cabem numa requisição. */
export function splitWindows(
  since: Date,
  until: Date,
  maxDays: number = MAX_DAYS_PER_REQUEST,
): { since: Date; until: Date }[] {
  const windows: { since: Date; until: Date }[] = [];
  const step = maxDays * 24 * 60 * 60 * 1000;

  let cursor = since.getTime();
  while (cursor <= until.getTime()) {
    const end = Math.min(cursor + step - 24 * 60 * 60 * 1000, until.getTime());
    windows.push({ since: new Date(cursor), until: new Date(end) });
    cursor = end + 24 * 60 * 60 * 1000;
  }

  return windows;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
