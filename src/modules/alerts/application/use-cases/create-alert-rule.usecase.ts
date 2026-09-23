import { Injectable } from '@nestjs/common';
import { AlertRule } from 'src/modules/alerts/domain/entities';
import { AlertRulesRepositoryInterface } from 'src/modules/alerts/domain/ports';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { toAlertRuleOutput } from '../alerts.presenter';
import { AlertRuleOutputDto, CreateAlertRuleInputDto } from '../dtos';

@Injectable()
export class CreateAlertRuleUseCase {
  constructor(
    private readonly rulesRepository: AlertRulesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: CreateAlertRuleInputDto,
  ): Promise<AlertRuleOutputDto> {
    assertPlatformPermission(operator, 'settings:manage');

    const rule = AlertRule.create(input);
    await this.rulesRepository.save(rule);

    const output = toAlertRuleOutput(rule);

    await this.audit.record({
      actor: operator,
      action: 'alert_rule.created',
      subjectType: 'ALERT_RULE',
      subjectId: rule.id,
      after: output,
    });

    return output;
  }
}
