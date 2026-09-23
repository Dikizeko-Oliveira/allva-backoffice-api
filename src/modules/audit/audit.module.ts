import { Global, Module } from '@nestjs/common';
import { BackofficeAuditController } from './audit.controller';
import { BackofficeAuditLogService } from './audit-log.service';

@Global()
@Module({
  controllers: [BackofficeAuditController],
  providers: [BackofficeAuditLogService],
  exports: [BackofficeAuditLogService],
})
export class AuditModule {}
