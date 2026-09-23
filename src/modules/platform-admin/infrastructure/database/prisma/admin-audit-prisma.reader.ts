import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type {
  AdminAuditEventRow,
  AdminAuditFilters,
  AuditSeverity,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import { AdminAuditReaderInterface } from 'src/modules/platform-admin/domain/ports';

type RawEvent = {
  id: string;
  kind: 'BUSINESS' | 'SECURITY';
  event: string;
  severity: AuditSeverity;
  actorId: string | null;
  organizationId: string | null;
  entityType: string | null;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: Date;
};

const SEVERITY: Record<string, AuditSeverity> = {
  info: 'INFO',
  warning: 'WARNING',
  critical: 'CRITICAL',
};

/**
 * As duas trilhas numa lista só: `audit_logs` (negócio) e
 * `security_audit_logs` (segurança). Eram gravadas por todo o backend e lidas
 * por nenhuma rota.
 *
 * ## Paginação sobre a união
 *
 * Duas tabelas ordenadas por data não se paginam com um `skip` só. Para a
 * página N, lê-se o topo `N × pageSize` de cada uma, intercala por data e
 * corta a fatia. É exato, e o custo cresce com a página — o que é aceitável
 * numa trilha que se lê do mais novo para o mais antigo, com filtro de período
 * para ir longe. Filtrar por `kind` lê uma tabela só.
 *
 * Evento de negócio não tem severidade gravada: é `INFO` por definição, e o
 * filtro por `WARNING`/`CRITICAL` o exclui sem consultar.
 */
@Injectable()
export class AdminAuditPrismaReader implements AdminAuditReaderInterface {
  constructor(private readonly prisma: PrismaService) {}

  async list(filters: AdminAuditFilters): Promise<Page<AdminAuditEventRow>> {
    const window = filters.page * filters.pageSize;
    const readBusiness =
      filters.kind !== 'SECURITY' &&
      (!filters.severity || filters.severity === 'INFO');
    const readSecurity = filters.kind !== 'BUSINESS';

    const matchingOrganizations = await this.organizationsNamed(filters.q);

    const [business, security] = await Promise.all([
      readBusiness
        ? this.business(filters, window, matchingOrganizations)
        : { total: 0, rows: [] },
      readSecurity
        ? this.security(filters, window, matchingOrganizations)
        : { total: 0, rows: [] },
    ]);

    const slice = [...business.rows, ...security.rows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice((filters.page - 1) * filters.pageSize, window);

    return {
      items: await this.present(slice),
      total: business.total + security.total,
      page: filters.page,
      pageSize: filters.pageSize,
    };
  }

  /**
   * `q` procura no nome do evento **e** no nome da organização — é como o
   * operador pergunta ("o que aconteceu na Fharmácia Vida"). As organizações
   * são resolvidas antes, uma vez, e entram como `organizationId IN (…)`.
   */
  private async organizationsNamed(q?: string): Promise<string[]> {
    if (!q?.trim()) return [];

    const rows = await this.prisma.organization.findMany({
      where: { name: { contains: q.trim(), mode: 'insensitive' } },
      select: { id: true },
      take: 200,
    });

    return rows.map((row) => row.id);
  }

  private textMatch(q: string | undefined, organizationIds: string[]) {
    if (!q?.trim()) return {};

    return {
      OR: [
        { event: { contains: q.trim(), mode: 'insensitive' as const } },
        ...(organizationIds.length
          ? [{ organizationId: { in: organizationIds } }]
          : []),
      ],
    };
  }

  private createdAtRange(filters: AdminAuditFilters) {
    return filters.from || filters.to
      ? {
          createdAt: {
            ...(filters.from && { gte: filters.from }),
            ...(filters.to && { lte: filters.to }),
          },
        }
      : {};
  }

  private async business(
    filters: AdminAuditFilters,
    take: number,
    organizationIds: string[],
  ): Promise<{ total: number; rows: RawEvent[] }> {
    const where: Prisma.AuditLogWhereInput = {
      ...this.createdAtRange(filters),
      ...(filters.organizationId && { organizationId: filters.organizationId }),
      ...(filters.actorId && { actorId: filters.actorId }),
      ...this.textMatch(filters.q, organizationIds),
    };

    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        kind: 'BUSINESS',
        event: row.event,
        severity: 'INFO',
        actorId: row.actorId,
        organizationId: row.organizationId,
        entityType: row.entityType,
        entityId: row.entityId,
        ipAddress: null,
        userAgent: null,
        metadata: row.metadata,
        createdAt: row.createdAt,
      })),
    };
  }

  private async security(
    filters: AdminAuditFilters,
    take: number,
    organizationIds: string[],
  ): Promise<{ total: number; rows: RawEvent[] }> {
    const where: Prisma.SecurityAuditLogWhereInput = {
      ...this.createdAtRange(filters),
      ...(filters.organizationId && { organizationId: filters.organizationId }),
      ...(filters.actorId && { accountId: filters.actorId }),
      ...this.textMatch(filters.q, organizationIds),
      ...(filters.severity && { severity: filters.severity.toLowerCase() }),
    };

    const [total, rows] = await Promise.all([
      this.prisma.securityAuditLog.count({ where }),
      this.prisma.securityAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take,
      }),
    ]);

    return {
      total,
      rows: rows.map((row) => ({
        id: row.id,
        kind: 'SECURITY',
        event: row.event,
        severity: SEVERITY[row.severity] ?? 'INFO',
        actorId: row.accountId,
        organizationId: row.organizationId,
        entityType: null,
        entityId: null,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: row.metadata,
        createdAt: row.createdAt,
      })),
    };
  }

  private async present(rows: RawEvent[]): Promise<AdminAuditEventRow[]> {
    const actorIds = [...new Set(rows.map((r) => r.actorId).filter(isString))];
    const organizationIds = [
      ...new Set(rows.map((r) => r.organizationId).filter(isString)),
    ];

    const [actors, organizations] = await Promise.all([
      this.prisma.account.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.organization.findMany({
        where: { id: { in: organizationIds } },
        select: { id: true, name: true },
      }),
    ]);

    const actorById = new Map(actors.map((a) => [a.id, a]));
    const organizationById = new Map(organizations.map((o) => [o.id, o]));

    return rows.map(({ actorId, organizationId, createdAt, ...row }) => ({
      ...row,
      actor: actorId ? (actorById.get(actorId) ?? null) : null,
      organization: organizationId
        ? (organizationById.get(organizationId) ?? null)
        : null,
      occurredAt: createdAt.toISOString(),
    }));
  }
}

function isString(value: string | null): value is string {
  return value !== null;
}
