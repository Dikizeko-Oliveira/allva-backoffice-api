import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { DomainEventBus } from '@/shared/domain/events/domain-event-bus';
import { createRootJobContext } from '@/shared/domain/events/job-context';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { CurrencyConverterService } from './currency-converter.service';

/** Quantas linhas por transação de recomputo. Checkpoint a cada lote. */
const BATCH_SIZE = 500;

export type CurrencyMigrationRequest = {
  organizationId: string;
  toCurrency: string;
  requestedByAccountId: string;
  correlationId?: string | null;
};

/**
 * Troca da moeda-base de uma organização (D3.4).
 *
 * **O recomputo não viola M2.** M2 congela a taxa **da linha**: `fxRate`,
 * `fxAsOf` e `fxSource` de um snapshot nunca são reescritos por este serviço. O
 * que muda é o valor `*Base`, recalculado com a taxa **histórica da data daquela
 * linha** contra a moeda-base nova — nunca com a taxa de hoje. Sem essa
 * distinção, D3.4 e M2 pareceriam se contradizer e a implementação escolheria
 * errado: reconverter tudo pela cotação de hoje reescreveria o passado.
 *
 * Enquanto corre, a organização fica em `RECOMPUTING_CURRENCY` e a inteligência
 * pausa (§8.7) — um agregado lido no meio do recomputo somaria linhas em duas
 * moedas diferentes.
 */
@Injectable()
export class CurrencyMigrationService {
  private readonly logger = new Logger(CurrencyMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly converter: CurrencyConverterService,
    private readonly events: DomainEventBus,
  ) {}

  /**
   * Registra o pedido e coloca a organização em recomputo.
   *
   * O índice parcial `currency_migrations_active_unique` garante no banco que
   * há no máximo um recomputo ativo por organização; a checagem aqui existe para
   * devolver 409 em vez de um erro de constraint.
   */
  async requestChange(request: CurrencyMigrationRequest) {
    const organization = await this.prisma.organization.findUniqueOrThrow({
      where: { id: request.organizationId },
      select: { id: true, baseCurrency: true, currencyState: true },
    });

    const toCurrency = request.toCurrency.toUpperCase();
    if (organization.baseCurrency.toUpperCase() === toCurrency) {
      throw new ConflictException({
        code: 'BASE_CURRENCY_UNCHANGED',
        message: `A organização já opera em ${toCurrency}.`,
      });
    }

    const active = await this.prisma.currencyMigration.findFirst({
      where: {
        organizationId: request.organizationId,
        status: { in: ['PENDING', 'RUNNING'] },
      },
      select: { id: true, status: true },
    });

    if (active) {
      throw new ConflictException({
        code: 'CURRENCY_RECOMPUTING',
        message: 'Já existe um recomputo de moeda em andamento.',
        migrationId: active.id,
      });
    }

    const migration = await this.prisma.$transaction(async (tx) => {
      const created = await tx.currencyMigration.create({
        data: {
          organizationId: request.organizationId,
          fromCurrency: organization.baseCurrency.toUpperCase(),
          toCurrency,
          requestedByAccountId: request.requestedByAccountId,
          correlationId: request.correlationId ?? null,
        },
      });

      await tx.organization.update({
        where: { id: request.organizationId },
        data: {
          currencyState: 'RECOMPUTING_CURRENCY',
          previousBaseCurrency: organization.baseCurrency,
          baseCurrency: toCurrency,
          baseCurrencyChangedAt: new Date(),
        },
      });

      return created;
    });

    this.events.emitFrom(
      {
        ...createRootJobContext(request.correlationId ?? undefined),
        organizationId: request.organizationId,
      },
      'organization.base_currency.change_requested',
      {
        from: migration.fromCurrency,
        to: migration.toCurrency,
        migrationId: migration.id,
      },
    );

    return migration;
  }

  /**
   * Executa o recomputo, em lotes, com checkpoint e observação de cancelamento.
   *
   * Cancelar só é seguro **antes** de escrever. De `RUNNING`, o pedido é
   * intenção: o worker o observa no próximo checkpoint e termina em
   * `ROLLED_BACK` — parar no meio deixaria metade das linhas numa moeda e metade
   * na outra, que é pior que qualquer uma das duas.
   */
  async run(migrationId: string): Promise<void> {
    const migration = await this.prisma.currencyMigration.findUniqueOrThrow({
      where: { id: migrationId },
    });

    if (migration.status !== 'PENDING') {
      this.logger.warn(
        `currency.migration_skipped id=${migrationId} status=${migration.status}`,
      );
      return;
    }

    await this.prisma.currencyMigration.update({
      where: { id: migrationId },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const rowCounts: Record<string, number> = {};

    try {
      rowCounts.ad_metric_snapshots = await this.recomputeSnapshots(
        migration.organizationId,
        migration.toCurrency,
        migrationId,
      );
      rowCounts.waste_items = await this.recomputeWasteItems(
        migration.organizationId,
        migration.toCurrency,
      );

      if (await this.cancellationRequested(migrationId)) {
        await this.finish(migrationId, 'ROLLED_BACK', rowCounts);
        return;
      }

      await this.finish(migrationId, 'COMPLETED', rowCounts);

      this.events.emitFrom(
        {
          ...createRootJobContext(migration.correlationId ?? undefined),
          organizationId: migration.organizationId,
        },
        'organization.base_currency.recomputed',
        {
          baseCurrency: migration.toCurrency,
          migrationId,
          rowCounts,
        },
      );
    } catch (error) {
      await this.prisma.currencyMigration.update({
        where: { id: migrationId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : String(error),
          rowCounts,
        },
      });
      throw error;
    }
  }

  /** Pedido de cancelamento; só encerra sozinho se o recomputo não começou. */
  async requestCancellation(
    migrationId: string,
    accountId: string,
  ): Promise<void> {
    const migration = await this.prisma.currencyMigration.update({
      where: { id: migrationId },
      data: {
        cancellationRequestedAt: new Date(),
        cancellationRequestedById: accountId,
      },
    });

    if (migration.status === 'PENDING') {
      await this.finish(migrationId, 'CANCELLED', {});
    }
  }

  /**
   * Recalcula `spend_base`/`revenue_base` com a taxa **da data de cada linha**.
   *
   * `fx_rate`, `fx_as_of` e `fx_source` são reescritos porque a taxa gravada
   * descrevia a conversão para a moeda-base **antiga**: mantê-la faria a linha
   * declarar uma procedência que não corresponde ao número ao lado (P7).
   */
  private async recomputeSnapshots(
    organizationId: string,
    toCurrency: string,
    migrationId: string,
  ): Promise<number> {
    let processed = 0;
    let cursor: { id: string; date: Date } | undefined;

    for (;;) {
      const batch = await this.prisma.adMetricSnapshot.findMany({
        where: { organizationId },
        orderBy: [{ date: 'asc' }, { id: 'asc' }],
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id_date: cursor }, skip: 1 } : {}),
      });

      if (batch.length === 0) break;

      for (const row of batch) {
        const [spend, revenue] = await Promise.all([
          this.converter.normalize({
            amount: Number(row.spend),
            fromCurrency: row.currency,
            toCurrency,
            date: row.date,
          }),
          this.converter.normalize({
            amount: Number(row.revenue),
            fromCurrency: row.currency,
            toCurrency,
            date: row.date,
          }),
        ]);

        await this.prisma.adMetricSnapshot.update({
          where: { id_date: { id: row.id, date: row.date } },
          data: {
            baseCurrency: toCurrency,
            spendBase: spend.valueBase,
            revenueBase: revenue.valueBase,
            fxRate: spend.fxRate,
            fxAsOf: spend.fxAsOf,
            fxSource: spend.fxSource,
            normalizationPending: spend.normalizationPending,
          },
        });
        processed += 1;
      }

      const last = batch[batch.length - 1];
      cursor = { id: last.id, date: last.date };

      await this.prisma.currencyMigration.update({
        where: { id: migrationId },
        data: {
          progress: {
            ad_metric_snapshots: {
              lastId: last.id,
              lastDate: last.date.toISOString(),
              rowsDone: processed,
            },
          },
        },
      });

      if (await this.cancellationRequested(migrationId)) break;
    }

    return processed;
  }

  private async recomputeWasteItems(
    organizationId: string,
    toCurrency: string,
  ): Promise<number> {
    const items = await this.prisma.wasteItem.findMany({
      where: { organizationId },
      select: {
        id: true,
        currency: true,
        incurredAmount: true,
        avoidableDailyAmount: true,
        detectedAt: true,
      },
    });

    for (const item of items) {
      const [incurred, avoidable] = await Promise.all([
        this.converter.normalize({
          amount: Number(item.incurredAmount),
          fromCurrency: item.currency,
          toCurrency,
          date: item.detectedAt,
        }),
        this.converter.normalize({
          amount: Number(item.avoidableDailyAmount),
          fromCurrency: item.currency,
          toCurrency,
          date: item.detectedAt,
        }),
      ]);

      await this.prisma.wasteItem.update({
        where: { id: item.id },
        data: {
          baseCurrency: toCurrency,
          incurredAmountBase: incurred.valueBase,
          avoidableDailyBase: avoidable.valueBase,
        },
      });
    }

    return items.length;
  }

  private async cancellationRequested(migrationId: string): Promise<boolean> {
    const row = await this.prisma.currencyMigration.findUnique({
      where: { id: migrationId },
      select: { cancellationRequestedAt: true },
    });

    return Boolean(row?.cancellationRequestedAt);
  }

  /**
   * Fecha a migração e devolve a organização a `STABLE`.
   *
   * A moeda-base **não volta atrás** num `ROLLED_BACK`: as linhas já recomputadas
   * estão na moeda nova, e reverter exigiria um segundo recomputo completo. O
   * estado registra o que aconteceu; a decisão de refazer é de quem opera.
   */
  private async finish(
    migrationId: string,
    status: 'COMPLETED' | 'CANCELLED' | 'ROLLED_BACK',
    rowCounts: Record<string, number>,
  ): Promise<void> {
    const migration = await this.prisma.currencyMigration.update({
      where: { id: migrationId },
      data: { status, completedAt: new Date(), rowCounts },
    });

    await this.prisma.organization.update({
      where: { id: migration.organizationId },
      data: { currencyState: 'STABLE' },
    });
  }
}
