import { InjectQueue } from '@nestjs/bull';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bull';
import type { JobContext } from 'src/shared/domain/events/job-context';
import {
  PERFORM_ACTION_JOB,
  PLATFORM_ACTIONS_QUEUE,
  REAP_EXECUTIONS_JOB,
  VERIFY_ACTION_JOB,
} from './platform-actions.constants';

/** Todo payload carrega `JobContext` (§5.6.2, ⊕16). */
export type PerformActionJobData = {
  ctx: JobContext;
  executionId: string;
  attempt: number;
};

export type VerifyActionJobData = {
  ctx: JobContext;
  executionId: string;
};

export type ReapExecutionsJobData = { ctx: JobContext };

@Injectable()
export class PlatformActionsDispatcher {
  constructor(
    @InjectQueue(PLATFORM_ACTIONS_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * **`attempts: 1` no Bull, sempre.**
   *
   * O retry de escrita não pode ser do broker: ele reexecutaria o job inteiro
   * sem saber se a chamada anterior chegou à plataforma, e "pausar duas vezes" é
   * inofensivo enquanto "somar orçamento duas vezes" não é. Quem decide repetir
   * é o serviço, que lê o estado da execução e reenfileira explicitamente com o
   * número da tentativa.
   *
   * `jobId` derivado da execução e da tentativa colapsa duplicatas do mesmo
   * passo sem impedir o passo seguinte.
   */
  async perform(data: PerformActionJobData): Promise<void> {
    await this.queue.add(PERFORM_ACTION_JOB, data, {
      jobId: `${PERFORM_ACTION_JOB}:${data.executionId}:${data.attempt}`,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async performLater(
    data: PerformActionJobData,
    delayMs: number,
  ): Promise<void> {
    await this.queue.add(PERFORM_ACTION_JOB, data, {
      jobId: `${PERFORM_ACTION_JOB}:${data.executionId}:${data.attempt}`,
      delay: delayMs,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  /** Um degrau da escada, agendado pelo atraso que o domínio calculou. */
  async verify(data: VerifyActionJobData, delayMs: number): Promise<void> {
    await this.queue.add(VERIFY_ACTION_JOB, data, {
      /**
       * O `jobId` **não** inclui a tentativa: dois degraus da mesma execução
       * nunca coexistem, e incluir o número deixaria um degrau duplicado passar
       * caso o worker reagendasse depois de já ter agendado.
       */
      jobId: `${VERIFY_ACTION_JOB}:${data.executionId}`,
      delay: delayMs,
      attempts: 1,
      removeOnComplete: 500,
      removeOnFail: 1000,
    });
  }

  async reap(data: ReapExecutionsJobData): Promise<void> {
    await this.queue.add(REAP_EXECUTIONS_JOB, data, {
      jobId: `${REAP_EXECUTIONS_JOB}:${fiveMinuteKey()}`,
      attempts: 1,
      removeOnComplete: 50,
      removeOnFail: 100,
    });
  }
}

/** A mesma janela de cinco minutos que o `JobRun` do reaper usa. */
function fiveMinuteKey(): string {
  const now = new Date();
  const bucket = String(Math.floor(now.getUTCMinutes() / 5) * 5).padStart(
    2,
    '0',
  );
  return `${now.toISOString().slice(0, 13)}:${bucket}`;
}
