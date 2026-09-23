import { Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { RequirePlatformPermissions } from '../auth/require-platform-permissions.decorator';
import { normalizePage, pageResult } from '../common/pagination';

type AuditRow = {
  id: string;
  actor_id: string;
  action: string;
  subject_type: string;
  subject_id: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
};

@Controller('audit-logs')
@RequirePlatformPermissions('audit:read')
export class BackofficeAuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(
    @Query()
    query: {
      actorId?: string;
      action?: string;
      subjectId?: string;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    },
  ) {
    const { page, pageSize, skip } = normalizePage(query);
    const rows = await this.prisma.$queryRawUnsafe<AuditRow[]>(
      `
        SELECT *
        FROM backoffice_audit_logs
        WHERE ($1::text IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR subject_id = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR created_at <= $5::timestamptz)
        ORDER BY created_at DESC
        LIMIT $6 OFFSET $7
      `,
      query.actorId ?? null,
      query.action ?? null,
      query.subjectId ?? null,
      query.from ?? null,
      query.to ?? null,
      pageSize,
      skip,
    );
    const [{ count }] = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `
        SELECT COUNT(*)::bigint AS count
        FROM backoffice_audit_logs
        WHERE ($1::text IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR subject_id = $3)
          AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR created_at <= $5::timestamptz)
      `,
      query.actorId ?? null,
      query.action ?? null,
      query.subjectId ?? null,
      query.from ?? null,
      query.to ?? null,
    );

    return pageResult(
      rows.map((row) => ({
        id: row.id,
        source: 'BACKOFFICE',
        actorId: row.actor_id,
        action: row.action,
        subjectType: row.subject_type,
        subjectId: row.subject_id,
        before: row.before,
        after: row.after,
        reason: row.reason,
        ip: row.ip,
        userAgent: row.user_agent,
        createdAt: row.created_at.toISOString(),
      })),
      Number(count),
      page,
      pageSize,
    );
  }
}
