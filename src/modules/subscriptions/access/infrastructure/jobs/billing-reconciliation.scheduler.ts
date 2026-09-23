import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bull';
import {
  BILLING_RECONCILIATION_JOB,
  BILLING_RECONCILIATION_QUEUE,
} from 'src/modules/subscriptions/access/infrastructure/jobs/billing-reconciliation.processor';

const FIVE_MINUTES_MS = 5 * 60 * 1000;

@Injectable()
export class BillingReconciliationScheduler implements OnModuleInit {
  private readonly logger = new Logger(BillingReconciliationScheduler.name);

  constructor(
    @InjectQueue(BILLING_RECONCILIATION_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit() {
    if (process.env.BILLING_RECONCILIATION_DISABLED === 'true') {
      this.logger.warn('Billing reconciliation scheduler disabled by env flag');
      return;
    }

    const intervalMs = Number(
      process.env.BILLING_RECONCILIATION_INTERVAL_MS ?? FIVE_MINUTES_MS,
    );

    await this.queue.add(
      BILLING_RECONCILIATION_JOB,
      { limit: 100 },
      {
        repeat: { every: intervalMs },
        removeOnComplete: true,
        removeOnFail: true,
        jobId: 'billing-reconciliation:repeat',
      },
    );

    this.logger.log(
      `Billing reconciliation scheduled every ${intervalMs}ms via queue=${BILLING_RECONCILIATION_QUEUE}`,
    );
  }
}
