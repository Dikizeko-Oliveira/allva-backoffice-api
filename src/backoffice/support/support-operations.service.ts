import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BackofficeAuditLogService } from '../audit/audit-log.service';
import { OperatorContext } from '../auth/operator-context';
import { ProductApiClient } from '../product/product-api.client';

type ProductPage<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

type ProductTicket = {
  id: string;
  status: string;
  priority: string;
  category?: string | null;
  assigneeId?: string | null;
  operatorId?: string | null;
  createdAt: string;
  lastMessageAt: string;
  messages?: { kind: string; createdAt: string }[];
  [key: string]: unknown;
};

type SlaPolicyRow = {
  id: string;
  priority: string;
  category: string | null;
  first_response_minutes: number;
  resolution_minutes: number;
  business_hours: boolean;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type TicketSlaRow = {
  ticket_id: string;
  assignee_id: string | null;
  escalated_at: Date | null;
  escalated_to: string | null;
  due_first_response_at: Date | null;
  due_resolution_at: Date | null;
  first_operator_reply_at: Date | null;
};

const LIVE_STATUSES = new Set(['OPEN', 'IN_PROGRESS']);
const PRIORITY_FALLBACK: Record<string, { first: number; resolution: number }> =
  {
    LOW: { first: 24 * 60, resolution: 5 * 24 * 60 },
    MEDIUM: { first: 8 * 60, resolution: 3 * 24 * 60 },
    HIGH: { first: 2 * 60, resolution: 24 * 60 },
    CRITICAL: { first: 30, resolution: 4 * 60 },
  };

@Injectable()
export class SupportOperationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly productApi: ProductApiClient,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async listQueue(
    operator: OperatorContext,
    query: Record<string, string | number | boolean | undefined>,
  ) {
    const page = await this.productApi.request<ProductPage<ProductTicket>>(
      '/api/v1/admin/support/tickets',
      { token: operator.token, query },
    );
    const items = await Promise.all(
      page.items.map((ticket) => this.enrichTicket(ticket)),
    );

    items.sort((a, b) => riskRank(b.sla.state) - riskRank(a.sla.state));

    return { ...page, items };
  }

  async getEnrichedTicket(operator: OperatorContext, ticketId: string) {
    const ticket = await this.productApi.request<ProductTicket>(
      `/api/v1/admin/support/tickets/${encodeURIComponent(ticketId)}`,
      { token: operator.token },
    );

    return this.enrichTicket(ticket);
  }

  async assignTicket(params: {
    operator: OperatorContext;
    ticketId: string;
    toOperatorId: string | null;
    reason?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }) {
    const before = await this.productApi.request<ProductTicket>(
      `/api/v1/admin/support/tickets/${encodeURIComponent(params.ticketId)}`,
      { token: params.operator.token },
    );
    const fromOperatorId = assigneeOf(before);

    if (
      fromOperatorId &&
      fromOperatorId !== params.toOperatorId &&
      !params.reason?.trim()
    ) {
      throw new BadRequestException({
        code: 'ASSIGNMENT_REASON_REQUIRED',
        message: 'Reason is required when reassigning a ticket',
        field: 'reason',
      });
    }

    const updated = await this.productApi.request<ProductTicket>(
      `/api/v1/admin/support/tickets/${encodeURIComponent(params.ticketId)}`,
      {
        method: 'PATCH',
        token: params.operator.token,
        body: { assigneeId: params.toOperatorId },
      },
    );

    await this.prisma.$executeRaw`
      INSERT INTO ticket_assignment_events (
        ticket_id, from_operator_id, to_operator_id, actor_id, reason
      )
      VALUES (
        ${params.ticketId},
        ${fromOperatorId},
        ${params.toOperatorId},
        ${params.operator.id},
        ${params.reason?.trim() || null}
      )
    `;

    await this.prisma.$executeRaw`
      UPDATE ticket_sla_snapshots
      SET assignee_id = ${params.toOperatorId}, updated_at = now()
      WHERE ticket_id = ${params.ticketId}
    `;

    await this.audit.record({
      actor: params.operator,
      action: 'support.ticket.assigned',
      subjectType: 'SUPPORT_TICKET',
      subjectId: params.ticketId,
      before: { assigneeId: fromOperatorId },
      after: { assigneeId: params.toOperatorId },
      reason: params.reason,
      ip: params.ip,
      userAgent: params.userAgent,
    });

    return this.enrichTicket(updated);
  }

  async listPolicies() {
    const rows = await this.prisma.$queryRaw<SlaPolicyRow[]>`
      SELECT * FROM sla_policies
      ORDER BY priority, category NULLS FIRST
    `;
    return rows.map(toPolicy);
  }

  async createPolicy(input: {
    priority: string;
    category?: string | null;
    firstResponseMinutes: number;
    resolutionMinutes: number;
    businessHours?: boolean;
    active?: boolean;
    operator: OperatorContext;
  }) {
    const [row] = await this.prisma.$queryRaw<SlaPolicyRow[]>`
      INSERT INTO sla_policies (
        priority, category, first_response_minutes, resolution_minutes, business_hours, active
      )
      VALUES (
        ${input.priority},
        ${input.category ?? null},
        ${input.firstResponseMinutes},
        ${input.resolutionMinutes},
        ${input.businessHours ?? false},
        ${input.active ?? true}
      )
      RETURNING *
    `;

    await this.audit.record({
      actor: input.operator,
      action: 'support.sla_policy.created',
      subjectType: 'SLA_POLICY',
      subjectId: row.id,
      after: toPolicy(row),
    });

    return toPolicy(row);
  }

  async updatePolicy(
    id: string,
    input: Partial<{
      priority: string;
      category: string | null;
      firstResponseMinutes: number;
      resolutionMinutes: number;
      businessHours: boolean;
      active: boolean;
    }> & { operator: OperatorContext },
  ) {
    const before = await this.findPolicy(id);
    if (!before)
      throw new NotFoundException({
        code: 'SLA_POLICY_NOT_FOUND',
        message: 'SLA policy not found',
      });

    const [row] = await this.prisma.$queryRaw<SlaPolicyRow[]>`
      UPDATE sla_policies
      SET
        priority = COALESCE(${input.priority ?? null}, priority),
        category = CASE WHEN ${Object.hasOwn(input, 'category')} THEN ${input.category ?? null} ELSE category END,
        first_response_minutes = COALESCE(${input.firstResponseMinutes ?? null}, first_response_minutes),
        resolution_minutes = COALESCE(${input.resolutionMinutes ?? null}, resolution_minutes),
        business_hours = COALESCE(${input.businessHours ?? null}, business_hours),
        active = COALESCE(${input.active ?? null}, active),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: input.operator,
      action: 'support.sla_policy.updated',
      subjectType: 'SLA_POLICY',
      subjectId: id,
      before,
      after: toPolicy(row),
    });

    return toPolicy(row);
  }

  async supportAttention(operator: OperatorContext) {
    const permissions = new Set(operator.platformPermissions);
    if (!permissions.has('support:read')) return [];

    const [breached] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM ticket_sla_snapshots
      WHERE status IN ('OPEN', 'IN_PROGRESS')
        AND (
          (due_first_response_at IS NOT NULL AND first_operator_reply_at IS NULL AND due_first_response_at < now())
          OR (due_resolution_at IS NOT NULL AND due_resolution_at < now())
        )
    `;
    const [atRisk] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM ticket_sla_snapshots
      WHERE status IN ('OPEN', 'IN_PROGRESS')
        AND (
          (due_first_response_at IS NOT NULL AND first_operator_reply_at IS NULL AND due_first_response_at BETWEEN now() AND now() + interval '2 hours')
          OR (due_resolution_at IS NOT NULL AND due_resolution_at BETWEEN now() AND now() + interval '2 hours')
        )
    `;
    const [escalated] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM ticket_sla_snapshots
      WHERE status IN ('OPEN', 'IN_PROGRESS')
        AND escalated_at IS NOT NULL
        AND escalated_acknowledged_at IS NULL
    `;
    const [mineWaiting] = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*)::bigint AS count
      FROM ticket_sla_snapshots
      WHERE status IN ('OPEN', 'IN_PROGRESS')
        AND assignee_id = ${operator.id}
        AND last_message_kind = 'CUSTOMER'
    `;

    return [
      signal(
        'support.sla_breached',
        'support:read',
        'CRITICAL',
        breached.count,
      ),
      signal('support.sla_at_risk', 'support:read', 'WARNING', atRisk.count),
      signal('support.escalated', 'support:read', 'WARNING', escalated.count),
      signal(
        'support.assigned_to_me_waiting',
        'support:read',
        'INFO',
        mineWaiting.count,
      ),
    ];
  }

  async metrics(query: { from?: string; to?: string; operatorId?: string }) {
    const [volume] = await this.prisma.$queryRawUnsafe<{ assigned: bigint }[]>(
      `
        SELECT COUNT(*)::bigint AS assigned
        FROM ticket_assignment_events
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)
          AND ($3::text IS NULL OR to_operator_id = $3)
      `,
      query.from ?? null,
      query.to ?? null,
      query.operatorId ?? null,
    );
    const [sla] = await this.prisma.$queryRawUnsafe<
      { total: bigint; breached: bigint }[]
    >(
      `
        SELECT COUNT(*)::bigint AS total,
          COUNT(*) FILTER (
            WHERE due_resolution_at IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at > due_resolution_at
          )::bigint AS breached
        FROM ticket_sla_snapshots
        WHERE ($1::timestamptz IS NULL OR created_at >= $1::timestamptz)
          AND ($2::timestamptz IS NULL OR created_at <= $2::timestamptz)
          AND ($3::text IS NULL OR assignee_id = $3)
      `,
      query.from ?? null,
      query.to ?? null,
      query.operatorId ?? null,
    );

    const total = Number(sla.total);
    const breached = Number(sla.breached);

    return {
      firstResponse: { medianMinutes: null, p90Minutes: null },
      resolution: { medianMinutes: null, p90Minutes: null },
      volume: {
        assigned: Number(volume.assigned),
        resolved: null,
        reopened: null,
      },
      withinSlaPercentage:
        total === 0
          ? null
          : Math.round(((total - breached) / total) * 10000) / 100,
    };
  }

  private async enrichTicket(ticket: ProductTicket) {
    const snapshot = await this.upsertSnapshot(ticket);
    const now = new Date();
    const dueDates = [
      snapshot.first_operator_reply_at ? null : snapshot.due_first_response_at,
      snapshot.due_resolution_at,
    ].filter((date): date is Date => Boolean(date));
    const nextDue =
      dueDates.sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const breached = dueDates.some((date) => date.getTime() < now.getTime());
    const atRisk = dueDates.some(
      (date) =>
        date.getTime() >= now.getTime() &&
        date.getTime() <= now.getTime() + 2 * 60 * 60 * 1000,
    );

    return {
      ...ticket,
      sla: {
        state: breached ? 'BREACHED' : atRisk ? 'AT_RISK' : 'ON_TRACK',
        dueFirstResponseAt:
          snapshot.due_first_response_at?.toISOString() ?? null,
        dueResolutionAt: snapshot.due_resolution_at?.toISOString() ?? null,
        nextDueAt: nextDue?.toISOString() ?? null,
        firstOperatorReplyAt:
          snapshot.first_operator_reply_at?.toISOString() ?? null,
      },
      escalation: {
        escalatedAt: snapshot.escalated_at?.toISOString() ?? null,
        escalatedTo: snapshot.escalated_to,
      },
    };
  }

  private async upsertSnapshot(ticket: ProductTicket): Promise<TicketSlaRow> {
    const policy = await this.resolvePolicy(ticket.priority, ticket.category);
    const createdAt = new Date(ticket.createdAt);
    const messages = ticket.messages ?? [];
    const firstOperatorReplyAt =
      messages
        .filter((message) => message.kind === 'OPERATOR')
        .map((message) => new Date(message.createdAt))
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const lastMessage = messages
      .map((message) => ({
        kind: message.kind,
        at: new Date(message.createdAt),
      }))
      .sort((a, b) => b.at.getTime() - a.at.getTime())[0];
    const dueFirstResponseAt = addMinutes(
      createdAt,
      policy.first_response_minutes,
    );
    const dueResolutionAt = addMinutes(createdAt, policy.resolution_minutes);

    const [row] = await this.prisma.$queryRaw<TicketSlaRow[]>`
      INSERT INTO ticket_sla_snapshots (
        ticket_id, priority, category, status, assignee_id, created_at,
        last_message_at, last_message_kind, due_first_response_at,
        due_resolution_at, first_operator_reply_at
      )
      VALUES (
        ${ticket.id},
        ${ticket.priority},
        ${ticket.category ?? null},
        ${ticket.status},
        ${assigneeOf(ticket)},
        ${createdAt},
        ${new Date(ticket.lastMessageAt)},
        ${lastMessage?.kind ?? null},
        ${dueFirstResponseAt},
        ${dueResolutionAt},
        ${firstOperatorReplyAt}
      )
      ON CONFLICT (ticket_id) DO UPDATE
      SET priority = EXCLUDED.priority,
          category = EXCLUDED.category,
          status = EXCLUDED.status,
          assignee_id = EXCLUDED.assignee_id,
          last_message_at = EXCLUDED.last_message_at,
          last_message_kind = EXCLUDED.last_message_kind,
          first_operator_reply_at = COALESCE(ticket_sla_snapshots.first_operator_reply_at, EXCLUDED.first_operator_reply_at),
          resolved_at = CASE WHEN EXCLUDED.status IN ('RESOLVED', 'CLOSED') THEN now() ELSE ticket_sla_snapshots.resolved_at END,
          updated_at = now()
      RETURNING ticket_id, assignee_id, escalated_at, escalated_to, due_first_response_at,
        due_resolution_at, first_operator_reply_at
    `;

    return row;
  }

  private async resolvePolicy(priority: string, category?: string | null) {
    const [row] = await this.prisma.$queryRaw<SlaPolicyRow[]>`
      SELECT *
      FROM sla_policies
      WHERE active = true
        AND priority = ${priority}
        AND (category = ${category ?? null} OR category IS NULL)
      ORDER BY category NULLS LAST
      LIMIT 1
    `;

    if (row) return row;

    const fallback = PRIORITY_FALLBACK[priority] ?? PRIORITY_FALLBACK.MEDIUM;
    return {
      first_response_minutes: fallback.first,
      resolution_minutes: fallback.resolution,
    } as SlaPolicyRow;
  }

  private async findPolicy(id: string) {
    const [row] = await this.prisma.$queryRaw<SlaPolicyRow[]>`
      SELECT * FROM sla_policies WHERE id = ${id}
    `;
    return row ? toPolicy(row) : null;
  }
}

function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

function assigneeOf(ticket: ProductTicket): string | null {
  return (ticket.assigneeId ?? ticket.operatorId ?? null) as string | null;
}

function riskRank(state: string): number {
  if (state === 'BREACHED') return 3;
  if (state === 'AT_RISK') return 2;
  return 1;
}

function toPolicy(row: SlaPolicyRow) {
  return {
    id: row.id,
    priority: row.priority,
    category: row.category,
    firstResponseMinutes: row.first_response_minutes,
    resolutionMinutes: row.resolution_minutes,
    businessHours: row.business_hours,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function signal(
  key: string,
  permission: string,
  severity: 'CRITICAL' | 'WARNING' | 'INFO',
  count: bigint,
) {
  return { key, permission, severity, count: Number(count) };
}
