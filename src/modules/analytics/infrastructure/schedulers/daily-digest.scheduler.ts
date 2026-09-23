import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { DailyDigestRepositoryInterface } from 'src/modules/analytics/domain/ports/daily-digest.repository';
import { DailyDigestService } from 'src/modules/analytics/application/services/daily-digest.service';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';

const RECENT_SYNC_WINDOW_HOURS = 24;

/**
 * O ciclo diário do resumo — **o único lugar que aciona a IA do card**.
 *
 * Roda às 06h, depois do scoring (05h30) e do ingest, porque o resumo descreve
 * o que aqueles produziram. A leitura da tela nunca gera nada: se não houver
 * resumo do dia, o card diz que ainda não há.
 *
 * **Só organizações com sync bem-sucedido nas últimas 24h entram na fila.** Uma
 * organização sem dado novo produziria digest idêntico e cairia em
 * `SKIPPED_DIGEST` — mas nem enfileirar economiza o ciclo inteiro, e o ciclo
 * inclui duas consultas de série por organização.
 *
 * **E só organização com acesso aberto.** A varredura diária de quem perdeu
 * acesso mantém `lastSuccessfulFullSyncAt` recente por dois dias, e sem esta
 * porta o resumo chamaria a IA para um card que ninguém consegue abrir.
 */
@Injectable()
export class DailyDigestScheduler {
  private readonly logger = new Logger(DailyDigestScheduler.name);

  constructor(
    private readonly digests: DailyDigestRepositoryInterface,
    private readonly service: DailyDigestService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @Cron('0 6 * * *', { name: 'daily-digest', timeZone: SCHEDULER_TIMEZONE })
  async run(): Promise<void> {
    const since = new Date(
      Date.now() - RECENT_SYNC_WINDOW_HOURS * 60 * 60 * 1000,
    );
    const { kept: organizationIds, skipped } = await this.sweep.keepByMode(
      await this.digests.listOrganizationsWithRecentSync(since),
      (organizationId) => organizationId,
      ['FULL'],
    );

    let created = 0;
    let reused = 0;

    for (const organizationId of organizationIds) {
      try {
        const result = await this.service.generateFor({ organizationId });

        if (result.outcome === 'CREATED') created += 1;
        if (result.outcome === 'REUSED') reused += 1;
      } catch (error) {
        // Uma organização que falha não pode derrubar o ciclo das outras: o
        // resumo é opcional por construção, e um erro aqui custaria o dia
        // inteiro de todo mundo.
        this.logger.error(
          `digest.failed organizationId=${organizationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    this.logger.log(
      `daily_digest.done organizações=${organizationIds.length} ` +
        `gerados=${created} reaproveitados=${reused} fora_por_acesso=${skipped}`,
    );
  }
}
