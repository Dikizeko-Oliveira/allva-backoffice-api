import { Injectable, NotFoundException } from '@nestjs/common';
import { AlertRulesRepositoryInterface } from 'src/modules/alerts/domain/ports';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { toAlertRuleOutput } from '../alerts.presenter';
import { AlertRuleOutputDto, UpdateAlertRuleInputDto } from '../dtos';

@Injectable()
export class UpdateAlertRuleUseCase {
  constructor(
    private readonly rulesRepository: AlertRulesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
    input: UpdateAlertRuleInputDto,
  ): Promise<AlertRuleOutputDto> {
    assertPlatformPermission(operator, 'settings:manage');

    const rule = await this.rulesRepository.findById(id);

    if (!rule) {
      throw new NotFoundException({
        code: 'ALERT_RULE_NOT_FOUND',
        message: 'Alert rule not found',
      });
    }

    const before = toAlertRuleOutput(rule);

    rule.update(input);
    await this.rulesRepository.update(rule);

    const after = toAlertRuleOutput(rule);

    await this.audit.record({
      actor: operator,
      action: 'alert_rule.updated',
      subjectType: 'ALERT_RULE',
      subjectId: id,
      before,
      after,
    });

    return after;
  }
}
