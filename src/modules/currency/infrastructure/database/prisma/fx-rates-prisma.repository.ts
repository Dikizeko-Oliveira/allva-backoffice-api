import { Injectable } from '@nestjs/common';
import { FxRate } from 'src/modules/currency/domain/fx-rate';
import {
  FxRateRangeQuery,
  FxRatesRepositoryInterface,
} from 'src/modules/currency/domain/ports/fx-rates.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * O único lugar do `src/` que fala `fx_rates` (§16.10).
 */
@Injectable()
export class FxRatesPrismaRepository implements FxRatesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findRange(query: FxRateRangeQuery): Promise<FxRate[]> {
    const rows = await this.prisma.fxRate.findMany({
      where: {
        toCurrency: { in: query.currencies },
        date: { gte: query.since, lte: query.until },
      },
      orderBy: { date: 'asc' },
    });

    return rows.map((row) => ({
      date: row.date,
      fromCurrency: row.fromCurrency,
      toCurrency: row.toCurrency,
      rate: Number(row.rate),
      source: row.source,
    }));
  }

  async saveMany(rates: FxRate[]): Promise<number> {
    if (rates.length === 0) return 0;

    // `skipDuplicates` sobre a unique `(date, from, to, source)`: recoletar a
    // mesma janela é operação normal — o backfill e o job diário se sobrepõem de
    // propósito para não deixar buraco — e não pode falhar por isso.
    const result = await this.prisma.fxRate.createMany({
      data: rates.map((rate) => ({
        date: rate.date,
        fromCurrency: rate.fromCurrency.toUpperCase(),
        toCurrency: rate.toCurrency.toUpperCase(),
        rate: rate.rate,
        source: rate.source,
      })),
      skipDuplicates: true,
    });

    return result.count;
  }

  async latestDateFor(currency: string): Promise<Date | null> {
    const row = await this.prisma.fxRate.findFirst({
      where: { toCurrency: currency.toUpperCase() },
      orderBy: { date: 'desc' },
      select: { date: true },
    });

    return row?.date ?? null;
  }

  async countDistinctDates(currency: string): Promise<number> {
    const groups = await this.prisma.fxRate.groupBy({
      by: ['date'],
      where: { toCurrency: currency.toUpperCase() },
    });

    return groups.length;
  }
}
