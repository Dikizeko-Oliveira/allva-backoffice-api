import { Module } from '@nestjs/common';
import { CurrencyConverterService } from './application/currency-converter.service';
import { CurrencyMigrationService } from './application/currency-migration.service';
import { FxRatesCollectionService } from './application/fx-rates-collection.service';
import { FxRateProviderInterface } from './domain/ports/fx-rate.provider';
import { FxRatesRepositoryInterface } from './domain/ports/fx-rates.repository';
import { FxRatesPrismaRepository } from './infrastructure/database/prisma/fx-rates-prisma.repository';
import { HttpFxRateProvider } from './infrastructure/providers/http-fx-rate.provider';
import { FxRatesScheduler } from './infrastructure/schedulers/fx-rates.scheduler';

/**
 * `currency` — dono único de toda lógica monetária (§5.2).
 *
 * Pode ser dependência de qualquer módulo e **não depende de nenhum** (§5.3
 * r.9). Nenhum outro módulo converte, arredonda, deriva por pivô ou lê
 * `fx_rates`: sem um dono único, M1–M4 viram disciplina que cada módulo cumpre
 * por conta própria, e a primeira violação é silenciosa — o mesmo gasto com dois
 * valores na mesma tela, ambos plausíveis.
 */
@Module({
  providers: [
    CurrencyConverterService,
    CurrencyMigrationService,
    FxRatesCollectionService,
    FxRatesScheduler,
    { provide: FxRatesRepositoryInterface, useClass: FxRatesPrismaRepository },
    { provide: FxRateProviderInterface, useClass: HttpFxRateProvider },
  ],
  exports: [
    CurrencyConverterService,
    CurrencyMigrationService,
    FxRatesCollectionService,
  ],
})
export class CurrencyModule {}
