import { Global, Module } from '@nestjs/common';
import { BackofficeAuditLogService } from './application/backoffice-audit-log.service';
import { ListBackofficeAuditLogsUseCase } from './application/use-cases';
import { BackofficeAuditLogsRepositoryInterface } from './domain/ports';
import { BackofficeAuditLogsPrismaRepository } from './infrastructure/database/prisma/backoffice-audit-logs-prisma.repository';
import { BackofficeAuditLogsController } from './infrastructure/http/controllers/backoffice-audit-logs.controller';

/**
 * Global porque toda escrita do backoffice-api é auditada: um `imports` em
 * cada módulo só repetiria isto.
 */
@Global()
@Module({
  controllers: [BackofficeAuditLogsController],
  providers: [
    BackofficeAuditLogService,
    ListBackofficeAuditLogsUseCase,
    {
      provide: BackofficeAuditLogsRepositoryInterface,
      useClass: BackofficeAuditLogsPrismaRepository,
    },
  ],
  exports: [BackofficeAuditLogService],
})
export class AuditModule {}
