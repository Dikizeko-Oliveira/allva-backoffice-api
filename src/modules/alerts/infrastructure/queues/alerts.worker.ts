import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { CreateAlertUseCase } from 'src/modules/alerts/application/use-cases/alert-use-cases';
import { ALERTS_QUEUE, RAISE_ALERT_JOB } from './alerts.constants';
import type { RaiseAlertJobData } from './alerts.dispatcher';

/**
 * Onde o alerta é de fato escrito.
 *
 * `CreateAlertUseCase` já é idempotente pelo fingerprint: uma recorrência da
 * mesma condição bumpa `occurrences` e `lastOccurredAt` em vez de criar uma
 * segunda linha, e só um alerta genuinamente novo dispara notificação. É isso
 * que mantém uma conta inalcançável por três dias em **um** e-mail, e não em
 * setenta e dois.
 */
@Processor(ALERTS_QUEUE)
export class AlertsWorker {
  private readonly logger = new Logger(AlertsWorker.name);

  constructor(private readonly createAlert: CreateAlertUseCase) {}

  @Process(RAISE_ALERT_JOB)
  async handle(job: Job<RaiseAlertJobData>): Promise<void> {
    const { ctx, ...input } = job.data;

    const alert = await this.createAlert.execute({
      organizationId: input.organizationId,
      type: input.type,
      severity: input.severity,
      title: input.title,
      message: input.message,
      subject: input.subject,
      correlationId: ctx.correlationId,
      metadata: input.metadata ?? null,
    });

    this.logger.log(
      `alert.raised type=${input.type} alertId=${alert.id} ` +
        `occurrences=${alert.occurrences} correlationId=${ctx.correlationId}`,
    );
  }
}
