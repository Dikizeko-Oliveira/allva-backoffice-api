import type { BackofficeAuditLog } from '../domain/entities';
import type { BackofficeAuditLogOutputDto } from './dtos';

export function toBackofficeAuditLogOutput(
  log: BackofficeAuditLog,
): BackofficeAuditLogOutputDto {
  return {
    id: log.id,
    source: 'BACKOFFICE',
    actorId: log.actorId,
    action: log.action,
    subjectType: log.subjectType,
    subjectId: log.subjectId,
    before: log.before,
    after: log.after,
    reason: log.reason,
    ip: log.ip,
    userAgent: log.userAgent,
    createdAt: log.createdAt,
  };
}
