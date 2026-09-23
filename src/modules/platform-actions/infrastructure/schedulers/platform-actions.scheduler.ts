import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { PlatformActionsDispatcher } from '../queues/platform-actions.dispatcher';

/**
 * O tick do reaper (C2, ⊕6).
 *
 * **Não olha `PLATFORM_ACTIONS_ENABLED`.** As outras schedulers do repositório
 * checam a flag do próprio motor antes de enfileirar, e aqui isso seria um erro:
 * desligar a escrita não faz desaparecerem as execuções que já estavam em voo
 * quando ela foi desligada — e são justamente elas que ficariam presas no índice
 * de I2, bloqueando o alvo até alguém mexer no banco. O reaper é a limpeza; ele
 * precisa sobreviver ao desligamento daquilo que ele limpa.
 */
@Injectable()
export class PlatformActionsScheduler {
  private readonly logger = new Logger(PlatformActionsScheduler.name);

  constructor(private readonly dispatcher: PlatformActionsDispatcher) {}

  @Cron('*/5 * * * *', {
    name: 'action-execution-reaper',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async reapExpired(): Promise<void> {
    await this.dispatcher.reap({ ctx: createRootJobContext() });
  }
}
