import { Global, Module } from '@nestjs/common';
import { AuditLogService } from './application/audit-log.service';
import { AuditLogsRepositoryInterface } from './domain/ports';
import { AuditLogsPrismaRepository } from './infrastructure/database/prisma';

/**
 * Global audit module: audit logging is a cross-cutting concern, so the writer
 * service is exported app-wide and any feature module can inject it without an
 * explicit import.
 */
@Global()
@Module({
  providers: [
    AuditLogService,
    {
      provide: AuditLogsRepositoryInterface,
      useClass: AuditLogsPrismaRepository,
    },
  ],
  exports: [AuditLogService],
})
export class AuditModule {}
