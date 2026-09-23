import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';
import { Job } from 'bull';
import { ReconcileSubscriptionUseCase } from 'src/modules/subscriptions/access/application/reconcile-subscription.usecase';
import { ExpireOrganizationTrialsUseCase } from 'src/modules/subscriptions/access/application/expire-organization-trials.usecase';

export const BILLING_RECONCILIATION_QUEUE = 'billing-reconciliation';
export const BILLING_RECONCILIATION_JOB = 'reconcile-subscriptions';

type BillingReconciliationJobData = {
  limit?: number;
};

@Processor(BILLING_RECONCILIATION_QUEUE)
export class BillingReconciliationProcessor {
  private readonly logger = new Logger(BillingReconciliationProcessor.name);

  constructor(
    private readonly reconcileUseCase: ReconcileSubscriptionUseCase,
    private readonly expireTrialsUseCase: ExpireOrganizationTrialsUseCase,
  ) {}

  @Process(BILLING_RECONCILIATION_JOB)
  async handle(job: Job<BillingReconciliationJobData>) {
    this.logger.log(`Running billing reconciliation job=${job.id}`);
    const reconciliation = await this.reconcileUseCase.execute({
      limit: job.data.limit,
    });
    const trialExpiry = await this.expireTrialsUseCase.execute();
    return { ...reconciliation, trialsExpired: trialExpiry.expired };
  }
}
