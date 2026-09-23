import { Injectable, Logger } from '@nestjs/common';
import {
  SecurityAuditLog,
  SecurityEvent,
  SecuritySeverity,
} from 'src/modules/security/domain/entities';
import { SecurityAuditLogsRepositoryInterface } from 'src/modules/security/domain/ports';

export type RecordSecurityEventInput = {
  event: SecurityEvent;
  severity?: SecuritySeverity;
  accountId?: string | null;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};

// Any metadata key matching this pattern is dropped before persistence so that
// secrets can never leak into the security trail (defence-in-depth on top of
// the calling convention of never passing raw secrets).
const SENSITIVE_KEY_PATTERN =
  /token|password|secret|hash|authorization|cookie/i;

function scrubMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!metadata) return null;

  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

/**
 * Central security-trail writer. Recording a security event must never break the
 * request that triggered it, so persistence failures are swallowed and logged
 * rather than propagated (same contract as the business AuditLogService).
 */
@Injectable()
export class SecurityAuditLogService {
  private readonly logger = new Logger(SecurityAuditLogService.name);

  constructor(
    private readonly repository: SecurityAuditLogsRepositoryInterface,
  ) {}

  async record(input: RecordSecurityEventInput): Promise<void> {
    try {
      const log = SecurityAuditLog.create({
        ...input,
        metadata: scrubMetadata(input.metadata),
      });
      await this.repository.save(log);
    } catch (error) {
      this.logger.error(
        `security_audit.record_failed event=${input.event} ip=${input.ipAddress ?? ''} accountId=${input.accountId ?? ''}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
