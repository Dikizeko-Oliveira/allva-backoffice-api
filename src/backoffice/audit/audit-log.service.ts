import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { OperatorContext } from '../auth/operator-context';

type AuditInput = {
  actor: OperatorContext;
  action: string;
  subjectType: string;
  subjectId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

@Injectable()
export class BackofficeAuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO backoffice_audit_logs (
        actor_id, action, subject_type, subject_id, before, after, reason, ip, user_agent
      )
      VALUES (
        ${input.actor.id},
        ${input.action},
        ${input.subjectType},
        ${input.subjectId},
        ${input.before === undefined ? null : JSON.stringify(input.before)}::jsonb,
        ${input.after === undefined ? null : JSON.stringify(input.after)}::jsonb,
        ${input.reason ?? null},
        ${input.ip ?? null},
        ${input.userAgent ?? null}
      )
    `;
  }
}
