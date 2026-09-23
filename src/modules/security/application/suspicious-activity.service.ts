import { Injectable } from '@nestjs/common';
import { SecurityAuditLogsRepositoryInterface } from 'src/modules/security/domain/ports';
import { SecurityAuditLogService } from './security-audit-log.service';

const DISTINCT_IP_WINDOW_SECONDS = 15 * 60;
const DISTINCT_IP_THRESHOLD = 4;

export type EvaluateInput = {
  accountId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/**
 * Best-effort behavioural signals derived from the security trail. Cheap to run
 * on the auth hot path and never throws (delegates persistence to the
 * never-throw SecurityAuditLogService). Intentionally conservative — it flags
 * for review rather than blocking.
 */
@Injectable()
export class SuspiciousActivityService {
  constructor(
    private readonly repository: SecurityAuditLogsRepositoryInterface,
    private readonly securityAuditLog: SecurityAuditLogService,
  ) {}

  async evaluate(input: EvaluateInput): Promise<void> {
    try {
      const since = new Date(Date.now() - DISTINCT_IP_WINDOW_SECONDS * 1000);

      const distinctIps = await this.repository.distinctIpCountByAccountSince({
        accountId: input.accountId,
        since,
      });

      if (distinctIps >= DISTINCT_IP_THRESHOLD) {
        await this.securityAuditLog.record({
          event: 'suspicious_activity',
          severity: 'critical',
          accountId: input.accountId,
          ipAddress: input.ipAddress,
          userAgent: input.userAgent,
          metadata: {
            reason: 'multiple_source_ips',
            distinctIps,
            windowSeconds: DISTINCT_IP_WINDOW_SECONDS,
          },
        });
      }
    } catch {
      // Detection is best-effort; never let it affect the auth flow.
    }
  }
}
