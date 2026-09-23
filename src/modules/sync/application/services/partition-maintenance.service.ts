import { Injectable, Logger } from '@nestjs/common';
import {
  MetricPartitionsRepositoryInterface,
  PARTITION_MARGIN_ALERT_THRESHOLD,
  PARTITION_TARGET_MONTHS_AHEAD,
  PartitionMargin,
} from 'src/modules/sync/domain/ports/metric-partitions.repository';

export type PartitionMaintenanceOutcome = PartitionMargin & {
  /** `true` quando a margem caiu abaixo do limiar e o alerta foi levantado. */
  marginLow: boolean;
};

/**
 * Manutenção mensal das partições de `ad_metric_snapshots` (achado C1, gate G4).
 *
 * **Ninguém criava partições futuras.** G4 exige ≥ 3 meses à frente e §8.8 não
 * tinha o job. O primeiro ingest depois da última partição falharia com
 * `no partition of relation found` — perda **total** de ingestão, e num dia que
 * ninguém escolheu: o da virada do mês em que a última partição vence.
 *
 * A margem é medida, não assumida. Cair abaixo de 2 meses levanta
 * `PARTITION_MARGIN_LOW` porque a falha, quando chega, é abrupta e total — e o
 * alerta precisa vir com semanas de antecedência, não com horas.
 */
@Injectable()
export class PartitionMaintenanceService {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(
    private readonly partitions: MetricPartitionsRepositoryInterface,
  ) {}

  async execute(): Promise<PartitionMaintenanceOutcome> {
    const margin = await this.partitions.ensureMonthlyPartitions(
      PARTITION_TARGET_MONTHS_AHEAD + 3,
    );

    const marginLow = margin.monthsAhead < PARTITION_MARGIN_ALERT_THRESHOLD;

    if (margin.created.length > 0) {
      this.logger.log(
        `partitions.created ${margin.created.join(', ')} margem=${margin.monthsAhead}m`,
      );
    }

    if (marginLow) {
      this.logger.error(
        `partitions.margin_low margem=${margin.monthsAhead}m alvo=${PARTITION_TARGET_MONTHS_AHEAD}m — ` +
          'o ingest falha inteiro quando a última partição vence',
      );
    }

    if (margin.defaultPartitionRows > 0) {
      // A `DEFAULT` é rede de segurança, não solução: linha que cai nela fica
      // fora da poda por partição e degrada toda consulta por data. G4 exige
      // que esteja vazia, e uma linha lá dentro significa que a manutenção
      // falhou em algum momento no passado.
      this.logger.error(
        `partitions.default_not_empty linhas=${margin.defaultPartitionRows} — ` +
          'houve ingest sem partição de destino; G4 falha até a realocação',
      );
    }

    // Cria as partições com folga sobre o alvo: o job é mensal, e criar
    // exatamente três meses faria a margem oscilar entre 3 e 2 o tempo todo,
    // disparando o alerta todo mês sem que nada estivesse errado.
    return { ...margin, marginLow };
  }
}
