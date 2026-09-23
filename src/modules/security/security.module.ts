import { Global, Module } from '@nestjs/common';
import {
  BruteForceProtectionService,
  SecurityAuditLogService,
  SuspiciousActivityService,
} from './application';
import { SecurityAuditLogsRepositoryInterface } from './domain/ports';
import { SecurityAuditLogsPrismaRepository } from './infrastructure/database/prisma';

/**
 * Global security module: the security trail, brute-force engine and
 * suspicious-activity detector are cross-cutting concerns exported app-wide so
 * any feature module can inject them without explicit wiring (same pattern as
 * AuditModule).
 */
@Global()
@Module({
  providers: [
    SecurityAuditLogService,
    BruteForceProtectionService,
    SuspiciousActivityService,
    {
      provide: SecurityAuditLogsRepositoryInterface,
      useClass: SecurityAuditLogsPrismaRepository,
    },
  ],
  exports: [
    SecurityAuditLogService,
    BruteForceProtectionService,
    SuspiciousActivityService,
  ],
})
export class SecurityModule {}
