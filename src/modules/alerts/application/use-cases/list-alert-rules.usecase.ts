import { Injectable } from '@nestjs/common';
import { AlertRulesRepositoryInterface } from 'src/modules/alerts/domain/ports';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { toAlertRuleOutput } from '../alerts.presenter';
import { AlertRuleOutputDto } from '../dtos';

@Injectable()
export class ListAlertRulesUseCase {
  constructor(
    private readonly rulesRepository: AlertRulesRepositoryInterface,
  ) {}

  async execute(operator: Operator): Promise<AlertRuleOutputDto[]> {
    assertPlatformPermission(operator, 'settings:read');

    const rules = await this.rulesRepository.list();
    return rules.map(toAlertRuleOutput);
  }
}
