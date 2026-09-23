import { Injectable } from '@nestjs/common';
import {
  MetricPartitionsRepositoryInterface,
  PartitionMargin,
} from 'src/modules/sync/domain/ports/metric-partitions.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const PARENT_TABLE = 'ad_metric_snapshots';
const DEFAULT_PARTITION = `${PARENT_TABLE}_default`;

/**
 * Criação idempotente de partições mensais por `RANGE(date)`.
 *
 * O DDL é montado com nomes derivados de datas — não há entrada do usuário em
 * lugar nenhum desta string, e `CREATE TABLE` não aceita parâmetro ligado para
 * identificador nem para limite de partição. Os únicos valores interpolados vêm
 * de `Date`, formatados aqui.
 */
@Injectable()
export class MetricPartitionsPrismaRepository extends MetricPartitionsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async ensureMonthlyPartitions(monthsAhead: number): Promise<PartitionMargin> {
    const created: string[] = [];
    const now = new Date();

    for (let offset = 0; offset <= monthsAhead; offset += 1) {
      const start = monthStart(now, offset);
      const end = monthStart(now, offset + 1);
      const name = partitionName(start);

      const existed = await this.partitionExists(name);
      if (existed) continue;

      await this.prisma.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS "${name}" PARTITION OF "${PARENT_TABLE}" ` +
          `FOR VALUES FROM ('${isoDate(start)}') TO ('${isoDate(end)}')`,
      );
      created.push(name);
    }

    return {
      monthsAhead: await this.measureMarginMonths(now),
      created,
      defaultPartitionRows: await this.countDefaultRows(),
    };
  }

  private async partitionExists(name: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = ${name}
      ) AS "exists"
    `;

    return rows[0]?.exists === true;
  }

  /**
   * Quantos meses **consecutivos** existem à frente do mês corrente.
   *
   * Consecutivos importa: uma partição solta em três meses não cobre o buraco de
   * dois, e contar o total daria uma margem confortável para uma tabela que
   * quebraria na próxima virada de mês.
   */
  private async measureMarginMonths(now: Date): Promise<number> {
    let ahead = 0;

    for (let offset = 1; offset <= 24; offset += 1) {
      const exists = await this.partitionExists(
        partitionName(monthStart(now, offset)),
      );
      if (!exists) break;
      ahead = offset;
    }

    return ahead;
  }

  /**
   * A `DEFAULT` é rede de segurança, não solução: linha que cai nela fica fora
   * da poda por partição e degrada toda consulta por data. G4 exige que esteja
   * **vazia**, e uma linha lá dentro é prova de que houve ingest sem partição de
   * destino em algum momento.
   */
  private async countDefaultRows(): Promise<number> {
    const exists = await this.partitionExists(DEFAULT_PARTITION);
    if (!exists) return 0;

    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*)::bigint AS count FROM "${DEFAULT_PARTITION}"`,
    );

    return Number(rows[0]?.count ?? 0);
  }
}

function monthStart(reference: Date, offsetMonths: number): Date {
  return new Date(
    Date.UTC(
      reference.getUTCFullYear(),
      reference.getUTCMonth() + offsetMonths,
      1,
    ),
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function partitionName(start: Date): string {
  const year = start.getUTCFullYear();
  const month = String(start.getUTCMonth() + 1).padStart(2, '0');
  return `${PARENT_TABLE}_${year}_${month}`;
}
