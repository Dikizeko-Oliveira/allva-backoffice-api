import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { FxRatesCollectionService } from 'src/modules/currency/application/fx-rates-collection.service';
import { FxRatesRepositoryInterface } from 'src/modules/currency/domain/ports/fx-rates.repository';

/**
 * Coleta diária de câmbio (§8.8) e o backfill de deploy (D19).
 *
 * O backfill roda **no boot**, uma vez, e só quando a cobertura está abaixo do
 * alvo: um deploy não pode gastar 400 dias de chamadas toda vez que um pod
 * reinicia. A verificação é por contagem de dias distintos já coletados — o
 * mesmo número que o gate G9 mede.
 *
 * Ainda **sem lease de `JobRun`**: a coordenação distribuída chega em A2-S3,
 * junto com o takeover condicional. Até lá, `skipDuplicates` no insert torna a
 * execução concorrente inofensiva — duas réplicas coletando a mesma janela
 * gravam o mesmo conjunto, não o dobro dele.
 */
@Injectable()
export class FxRatesScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(FxRatesScheduler.name);

  constructor(
    private readonly collection: FxRatesCollectionService,
    private readonly repository: FxRatesRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const target = this.env.get('FX_BACKFILL_DAYS');
    const pivot = this.env.get('FX_PIVOT_CURRENCY');

    try {
      // A moeda-base padrão é a que praticamente toda organização usa; se ela
      // já tem cobertura, o backfill não tem o que fazer.
      const covered = await this.repository.countDistinctDates('BRL');
      if (covered >= target) {
        this.logger.log(
          `fx.backfill_skipped cobertura=${covered}d alvo=${target}d pivô=${pivot}`,
        );
        return;
      }

      const result = await this.collection.backfill();
      this.logger.log(
        `fx.backfill cobertura_anterior=${covered}d dias=${result.requestedDays} novas=${result.stored}` +
          (result.skippedReason ? ` motivo=${result.skippedReason}` : ''),
      );
    } catch (error) {
      // Câmbio degradado não pode impedir o boot: sem taxa, a ingestão segue com
      // `normalizationPending` e a inteligência declara evidência reduzida.
      this.logger.error(
        `fx.backfill_failed ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @Cron('0 5 * * *', {
    name: 'fx-rates-collection',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async collectDaily(): Promise<void> {
    const result = await this.collection.collectDaily();
    this.logger.log(
      `fx.daily moedas=${result.currencies.length} novas=${result.stored}` +
        (result.skippedReason ? ` motivo=${result.skippedReason}` : ''),
    );
  }
}
