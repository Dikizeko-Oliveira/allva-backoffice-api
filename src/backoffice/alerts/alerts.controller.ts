import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BackofficeAuditLogService } from '../audit/audit-log.service';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';
import { RequirePlatformPermissions } from '../auth/require-platform-permissions.decorator';
import { normalizePage, pageResult } from '../common/pagination';

type AlertRuleRow = {
  id: string;
  source: string;
  threshold: string;
  channel: string;
  target: string;
  required_permission: string;
  quiet_hours: unknown;
  active: boolean;
  created_at: Date;
  updated_at: Date;
};

type AlertEventRow = {
  id: string;
  rule_id: string;
  source: string;
  severity: string;
  payload: unknown;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  created_at: Date;
  required_permission: string;
};

@Controller()
export class AlertsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  @Get('alert-rules')
  @RequirePlatformPermissions('settings:read')
  async listRules() {
    const rows = await this.prisma.$queryRaw<AlertRuleRow[]>`
      SELECT * FROM alert_rules ORDER BY source, created_at DESC
    `;
    return rows.map(toRule);
  }

  @Post('alert-rules')
  @RequirePlatformPermissions('settings:manage')
  async createRule(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      source: string;
      threshold: string;
      channel: 'EMAIL' | 'SLACK';
      target: string;
      requiredPermission: string;
      quietHours?: unknown;
      active?: boolean;
    },
  ) {
    const [row] = await this.prisma.$queryRaw<AlertRuleRow[]>`
      INSERT INTO alert_rules (
        source, threshold, channel, target, required_permission, quiet_hours, active
      )
      VALUES (
        ${body.source},
        ${body.threshold},
        ${body.channel},
        ${body.target},
        ${body.requiredPermission},
        ${JSON.stringify(body.quietHours ?? null)}::jsonb,
        ${body.active ?? true}
      )
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'alert_rule.created',
      subjectType: 'ALERT_RULE',
      subjectId: row.id,
      after: toRule(row),
    });

    return toRule(row);
  }

  @Patch('alert-rules/:id')
  @RequirePlatformPermissions('settings:manage')
  async updateRule(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      source: string;
      threshold: string;
      channel: 'EMAIL' | 'SLACK';
      target: string;
      requiredPermission: string;
      quietHours: unknown;
      active: boolean;
    }>,
  ) {
    const before = await this.findRule(id);
    const [row] = await this.prisma.$queryRaw<AlertRuleRow[]>`
      UPDATE alert_rules
      SET
        source = COALESCE(${body.source ?? null}, source),
        threshold = COALESCE(${body.threshold ?? null}, threshold),
        channel = COALESCE(${body.channel ?? null}, channel),
        target = COALESCE(${body.target ?? null}, target),
        required_permission = COALESCE(${body.requiredPermission ?? null}, required_permission),
        quiet_hours = CASE WHEN ${Object.hasOwn(body, 'quietHours')} THEN ${JSON.stringify(body.quietHours ?? null)}::jsonb ELSE quiet_hours END,
        active = COALESCE(${body.active ?? null}, active),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'alert_rule.updated',
      subjectType: 'ALERT_RULE',
      subjectId: id,
      before: toRule(before),
      after: toRule(row),
    });

    return toRule(row);
  }

  @Get('alerts')
  async listEvents(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: { acknowledged?: string; page?: number; pageSize?: number },
  ) {
    const { page, pageSize, skip } = normalizePage(query);
    const acknowledged =
      query.acknowledged === undefined ? null : query.acknowledged === 'true';
    const rows = await this.prisma.$queryRawUnsafe<AlertEventRow[]>(
      `
        SELECT e.*, r.required_permission
        FROM alert_events e
        JOIN alert_rules r ON r.id = e.rule_id
        WHERE r.required_permission = ANY($1::text[])
          AND ($2::boolean IS NULL OR (e.acknowledged_at IS NOT NULL) = $2)
        ORDER BY e.created_at DESC
        LIMIT $3 OFFSET $4
      `,
      operator.platformPermissions,
      acknowledged,
      pageSize,
      skip,
    );
    const [{ count }] = await this.prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `
        SELECT COUNT(*)::bigint AS count
        FROM alert_events e
        JOIN alert_rules r ON r.id = e.rule_id
        WHERE r.required_permission = ANY($1::text[])
          AND ($2::boolean IS NULL OR (e.acknowledged_at IS NOT NULL) = $2)
      `,
      operator.platformPermissions,
      acknowledged,
    );

    return pageResult(rows.map(toEvent), Number(count), page, pageSize);
  }

  @Post('alerts/:id/acknowledge')
  async acknowledge(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
  ) {
    const [event] = await this.prisma.$queryRaw<AlertEventRow[]>`
      SELECT e.*, r.required_permission
      FROM alert_events e
      JOIN alert_rules r ON r.id = e.rule_id
      WHERE e.id = ${id}
    `;

    if (!event) {
      throw new NotFoundException({
        code: 'ALERT_EVENT_NOT_FOUND',
        message: 'Alert event not found',
      });
    }

    if (!operator.platformPermissions.includes(event.required_permission)) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message: `Account not authorized: requires platform permission "${event.required_permission}"`,
        details: { permission: event.required_permission },
      });
    }

    const [updated] = await this.prisma.$queryRaw<AlertEventRow[]>`
      UPDATE alert_events
      SET acknowledged_by = COALESCE(acknowledged_by, ${operator.id}),
          acknowledged_at = COALESCE(acknowledged_at, now())
      WHERE id = ${id}
      RETURNING *, ${event.required_permission} AS required_permission
    `;

    await this.audit.record({
      actor: operator,
      action: 'alert_event.acknowledged',
      subjectType: 'ALERT_EVENT',
      subjectId: id,
      after: toEvent(updated),
    });

    return toEvent(updated);
  }

  private async findRule(id: string) {
    const [row] = await this.prisma.$queryRaw<AlertRuleRow[]>`
      SELECT * FROM alert_rules WHERE id = ${id}
    `;
    if (!row) {
      throw new NotFoundException({
        code: 'ALERT_RULE_NOT_FOUND',
        message: 'Alert rule not found',
      });
    }
    return row;
  }
}

function toRule(row: AlertRuleRow) {
  return {
    id: row.id,
    source: row.source,
    threshold: row.threshold,
    channel: row.channel,
    target: row.target,
    requiredPermission: row.required_permission,
    quietHours: row.quiet_hours,
    active: row.active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toEvent(row: AlertEventRow) {
  return {
    id: row.id,
    ruleId: row.rule_id,
    source: row.source,
    severity: row.severity,
    payload: row.payload,
    requiredPermission: row.required_permission,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}
