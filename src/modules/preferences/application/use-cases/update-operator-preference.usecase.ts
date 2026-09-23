import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import type { Operator } from 'src/modules/auth/domain/entities';
import { OperatorPreference } from 'src/modules/preferences/domain/entities';
import { OperatorPreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import {
  OperatorPreferenceOutputDto,
  UpdateOperatorPreferenceInputDto,
} from '../dtos';
import { toOperatorPreferenceOutput } from '../preferences.presenter';

/** Mesmo recorte de `GetOperatorPreferenceUseCase`: só as do próprio operador. */
@Injectable()
export class UpdateOperatorPreferenceUseCase {
  constructor(
    private readonly preferencesRepository: OperatorPreferencesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: UpdateOperatorPreferenceInputDto,
  ): Promise<OperatorPreferenceOutputDto> {
    const preference =
      (await this.preferencesRepository.findByOperatorId(operator.id)) ??
      OperatorPreference.defaultsFor(operator.id);

    preference.replace(input);
    await this.preferencesRepository.save(preference);

    const output = toOperatorPreferenceOutput(preference);

    await this.audit.record({
      actor: operator,
      action: 'operator_preferences.updated',
      subjectType: 'OPERATOR',
      subjectId: operator.id,
      after: output,
    });

    return output;
  }
}
