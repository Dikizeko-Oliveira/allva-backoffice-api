import { Controller, Get } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';
import { SupportOperationsService } from '../support/support-operations.service';

type AlertSignalRow = {
  required_permission: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  count: bigint;
};

@Controller('hub')
export class HubController {
  constructor(
    private readonly support: SupportOperationsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('attention')
  async attention(@CurrentOperator() operator: OperatorContext) {
    const [supportSignals, alertSignals] = await Promise.all([
      this.support.supportAttention(operator),
      this.alertAttention(operator),
    ]);

    const signals = [...supportSignals, ...alertSignals].sort(compareSignals);

    return { generatedAt: new Date().toISOString(), signals };
  }

  private async alertAttention(operator: OperatorContext) {
    const permissions = operator.platformPermissions;
    if (permissions.length === 0) return [];

    const rows = await this.prisma.$queryRaw<AlertSignalRow[]>`
      SELECT r.required_permission, e.severity, COUNT(*)::bigint AS count
      FROM alert_events e
      JOIN alert_rules r ON r.id = e.rule_id
      WHERE e.acknowledged_at IS NULL
        AND r.required_permission = ANY(${permissions}::text[])
      GROUP BY r.required_permission, e.severity
    `;

    return rows.map((row) => ({
      key: 'alerts.unacknowledged',
      permission: row.required_permission,
      severity: row.severity,
      count: Number(row.count),
    }));
  }
}

const SEVERITY_ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };

function compareSignals(
  a: { severity: 'CRITICAL' | 'WARNING' | 'INFO' },
  b: { severity: 'CRITICAL' | 'WARNING' | 'INFO' },
) {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}
