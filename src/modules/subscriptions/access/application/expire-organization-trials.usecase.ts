import { Injectable, Logger } from '@nestjs/common';
import { OrganizationEntitlementRepositoryInterface } from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';

export type ExpireTrialsResult = {
  scanned: number;
  expired: number;
};

/**
 * Persists the TRIALING → EXPIRED transition for organization subscriptions
 * whose trial window has closed. The access resolver already blocks an elapsed
 * trial at read time, so this job only makes the stored status consistent for
 * reporting and downstream queries — access correctness never depends on it.
 */
@Injectable()
export class ExpireOrganizationTrialsUseCase {
  private readonly logger = new Logger(ExpireOrganizationTrialsUseCase.name);

  constructor(
    private readonly organizationEntitlementRepository: OrganizationEntitlementRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(input?: { limit?: number }): Promise<ExpireTrialsResult> {
    const limit = input?.limit ?? 200;
    const now = new Date();

    const expiredTrials =
      await this.organizationEntitlementRepository.listExpiredTrials(
        now,
        limit,
      );

    let expired = 0;

    for (const trial of expiredTrials) {
      try {
        await this.organizationEntitlementRepository.markExpired(trial.id);
        expired += 1;

        await this.auditLog.record({
          event: 'subscription.trial_expired',
          entityType: 'organization_subscription',
          entityId: trial.id,
          organizationId: trial.organizationId,
          metadata: { organizationId: trial.organizationId },
        });
      } catch (error) {
        this.logger.warn(
          `Failed to expire trial organizationSubscription=${trial.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (expired > 0) {
      this.logger.log(
        `Organization trial expiry finished: scanned=${expiredTrials.length} expired=${expired}`,
      );
    }

    return { scanned: expiredTrials.length, expired };
  }
}
