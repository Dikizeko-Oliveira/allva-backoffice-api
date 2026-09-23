import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { startOfUtcDay } from '../domain/currency-normalization.service';
import { FxRateProviderInterface } from '../domain/ports/fx-rate.provider';
import { FxRatesRepositoryInterface } from '../domain/ports/fx-rates.repository';

export type CollectionResult = {
  currencies: string[];
  requestedDays: number;
  fetched: number;
  stored: number;
  skippedReason?: 'PROVIDER_NOT_CONFIGURED' | 'NO_CURRENCIES';
};

/**
 * Coleta de câmbio: a diária e o backfill histórico (D19).
 *
 * O backfill é de **400 dias** por decisão declarada: cobre a retenção de 13
 * meses e a linhagem que a atravessa. Um backfill curto faria toda linha
 * anterior a ele entrar com `normalizationPending` — e linha pendente fica fora
 * de toda agregação de inteligência (M1), o que é o mesmo que não ter o dado.
 */
@Injectable()
export class FxRatesCollectionService {
  private readonly logger = new Logger(FxRatesCollectionService.name);

  constructor(
    private readonly provider: FxRateProviderInterface,
    private readonly repository: FxRatesRepositoryInterface,
    private readonly prisma: PrismaService,
    private readonly env: EnvService,
  ) {}

  /** Janela curta diária, com folga para cobrir cotação publicada com atraso. */
  async collectDaily(): Promise<CollectionResult> {
    const until = startOfUtcDay(new Date());
    const since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.collect(since, until);
  }

  /** Backfill de deploy: `FX_BACKFILL_DAYS` (400) até hoje. */
  async backfill(days?: number): Promise<CollectionResult> {
    const window = days ?? this.env.get('FX_BACKFILL_DAYS');
    const until = startOfUtcDay(new Date());
    const since = new Date(until.getTime() - window * 24 * 60 * 60 * 1000);
    return this.collect(since, until);
  }

  private async collect(since: Date, until: Date): Promise<CollectionResult> {
    const currencies = await this.observedCurrencies();
    const requestedDays =
      Math.round((until.getTime() - since.getTime()) / 86_400_000) + 1;

    if (currencies.length === 0) {
      return {
        currencies,
        requestedDays,
        fetched: 0,
        stored: 0,
        skippedReason: 'NO_CURRENCIES',
      };
    }

    if (!this.provider.isConfigured()) {
      // Degradação declarada, não falha: sem vendor a ingestão continua e as
      // linhas ficam `normalizationPending` até alguém configurar um.
      this.logger.warn(
        'fx.collection_skipped provedor não configurado (FX_PROVIDER_BASE_URL ausente)',
      );
      return {
        currencies,
        requestedDays,
        fetched: 0,
        stored: 0,
        skippedReason: 'PROVIDER_NOT_CONFIGURED',
      };
    }

    const rates = await this.provider.getHistorical({
      pivotCurrency: this.env.get('FX_PIVOT_CURRENCY'),
      currencies,
      since,
      until,
    });

    const stored = await this.repository.saveMany(rates);
    this.logger.log(
      `fx.collected moedas=${currencies.join(',')} dias=${requestedDays} recebidas=${rates.length} novas=${stored}`,
    );

    return { currencies, requestedDays, fetched: rates.length, stored };
  }

  /**
   * As moedas que o produto de fato observa: a de cada conta de anúncios mais a
   * moeda-base de cada organização.
   *
   * Lê duas colunas de outros módulos — códigos ISO, não domínio — em vez de
   * coletar uma lista fixa de dezenas de moedas todo dia. `currency` continua
   * sem depender de módulo nenhum (§5.3 r.9): não importa serviço, não importa
   * port, não conhece `AdAccount` como entidade.
   */
  private async observedCurrencies(): Promise<string[]> {
    const [accounts, organizations] = await Promise.all([
      this.prisma.adAccount.findMany({
        select: { currency: true },
        distinct: ['currency'],
      }),
      this.prisma.organization.findMany({
        select: { baseCurrency: true },
        distinct: ['baseCurrency'],
      }),
    ]);

    const configured = (this.env.get('FX_TRACKED_CURRENCIES') ?? '')
      .split(',')
      .map((currency) => currency.trim().toUpperCase())
      .filter(Boolean);

    const observed = new Set<string>([
      ...configured,
      ...accounts.map((account) => account.currency.toUpperCase()),
      ...organizations.map((organization) =>
        organization.baseCurrency.toUpperCase(),
      ),
    ]);

    observed.delete(this.env.get('FX_PIVOT_CURRENCY').toUpperCase());

    return [...observed].sort();
  }
}
