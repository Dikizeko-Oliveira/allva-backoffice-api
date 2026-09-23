import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import { JobContext } from 'src/shared/domain/events/job-context';
import type {
  AlertSeverity,
  AlertSubject,
  AlertType,
} from 'src/modules/alerts/domain/ports/alerts.repository';
import { ALERTS_QUEUE, RAISE_ALERT_JOB } from './alerts.constants';

/**
 * O que atravessa a fila até virar alerta.
 *
 * Carrega `JobContext` como toda fila da v2.0 (§5.6.2, ⊕16): o alerta que
 * aparece na tela às 14h07 precisa ser rastreável até o ingest das 14h que o
 * causou, e a correlação morre na primeira fronteira assíncrona se não viajar
 * junto.
 */
export type RaiseAlertJobData = {
  ctx: JobContext;
  organizationId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  subject: AlertSubject;
  metadata?: Record<string, unknown> | null;
};

/**
 * A fronteira entre o barramento e a escrita do alerta.
 *
 * `EventEmitter2` é **síncrono**: um handler que persistisse e mandasse e-mail
 * inline poria a latência do alerta dentro do emissor, e o ingest passaria a
 * esperar o SMTP para terminar de sincronizar uma conta (⊕10). O handler só
 * enfileira; quem escreve é o worker.
 */
@Injectable()
export class AlertsDispatcher {
  constructor(@InjectQueue(ALERTS_QUEUE) private readonly queue: Queue) {}

  async raise(data: RaiseAlertJobData, jobId?: string): Promise<void> {
    await this.queue.add(RAISE_ALERT_JOB, data, {
      // `jobId` derivado do evento colapsa a reentrega no mesmo job. Não
      // substitui o dedupe por fingerprint no repositório — Bull esquece ids
      // evictados —, mas cobre o caso barato antes de chegar ao banco.
      ...(jobId ? { jobId } : {}),
      attempts: 3,
      backoff: { type: 'exponential', delay: 15_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    });
  }
}
