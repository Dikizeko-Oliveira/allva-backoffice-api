import { AuditLog } from '../entities';

export abstract class AuditLogsRepositoryInterface {
  abstract save(auditLog: AuditLog): Promise<void>;
  abstract listByOrganizationId(
    organizationId: string,
    limit?: number,
  ): Promise<AuditLog[]>;
}
