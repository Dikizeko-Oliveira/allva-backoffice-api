import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { AdScoringTargetsRepositoryInterface } from 'src/modules/ad-scoring/domain/ports/ad-scoring-targets.repository';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { AdScoringDispatcher } from '../queues/ad-scoring.dispatcher';

/**
 * O ciclo diário de §8.8, enfileirado — **rede de segurança, não gatilho
 * principal**.
 *
 * Roda depois da varredura completa (03h20) porque depende dela; mas a
 * dependência é verificada no worker, por consulta a `JobRun`, e não presumida
 * pelo horário. Um cron que confia no relógio quebra silenciosamente no dia em
 * que a conta grande demora vinte minutos a mais.
 */
@Injectable()
export class AdScoringScheduler {
  private readonly logger = new Logger(AdScoringScheduler.name);

  constructor(
    private readonly targets: AdScoringTargetsRepositoryInterface,
    private readonly dispatcher: AdScoringDispatcher,
    private readonly env: EnvService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  @Cron('30 5 * * *', { name: 'ad-scoring', timeZone: SCHEDULER_TIMEZONE })
  async scoreDaily(): Promise<void> {
    if (!this.env.get('AD_SCORING_ENABLED')) {
      this.logger.debug('ad_scoring.disabled AD_SCORING_ENABLED=false');
      return;
    }

    const ctx = createRootJobContext();

    // Pontuar é análise: só organização com acesso aberto. Quem está na janela
    // de sync diário recebe o número, não a leitura dele.
    const { kept, skipped } = await this.sweep.keepByMode(
      await this.targets.listAccountsToScore(),
      (account) => account.organizationId,
      ['FULL'],
    );

    for (const account of kept) {
      await this.dispatcher.score({ ctx, adAccountId: account.adAccountId });
    }

    this.logger.log(
      `ad_scoring.enqueued contas=${kept.length} fora_por_acesso=${skipped}`,
    );
  }
}
