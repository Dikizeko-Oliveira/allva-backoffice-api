import { Injectable, Logger } from '@nestjs/common';
import { AuditLog, AuditEvent } from 'src/modules/audit/domain/entities';
import { AuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';

export type RecordAuditInput = {
  event: AuditEvent;
  entityType?: string | null;
  entityId?: string | null;
  actorId?: string | null;
  organizationId?: string | null;
  metadata?: Record<string, unknown> | null;
};

/**
 * Central audit-trail writer. Recording an audit event must never break the
 * business operation it describes, so persistence failures are swallowed and
 * logged rather than propagated. Callers that need the audit row to be part of
 * the same atomic transaction (e.g. provisioning) write to the tx client
 * directly instead of going through this service.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    private readonly auditLogsRepository: AuditLogsRepositoryInterface,
  ) {}

  async record(input: RecordAuditInput): Promise<void> {
    try {
      const auditLog = AuditLog.create(input);
      await this.auditLogsRepository.save(auditLog);
    } catch (error) {
      this.logger.error(
        `audit.record_failed event=${input.event} organizationId=${input.organizationId ?? ''} entityId=${input.entityId ?? ''}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
