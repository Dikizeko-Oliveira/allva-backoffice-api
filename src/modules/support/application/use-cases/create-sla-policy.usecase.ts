import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SlaPolicy } from 'src/modules/support/domain/entities';
import { SlaPoliciesRepositoryInterface } from 'src/modules/support/domain/ports';
import { CreateSlaPolicyInputDto, SlaPolicyOutputDto } from '../dtos';
import { assertScopeIsFree } from '../sla-policy-scope';
import { toSlaPolicyOutput } from '../support.presenter';

@Injectable()
export class CreateSlaPolicyUseCase {
  constructor(
    private readonly policiesRepository: SlaPoliciesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: CreateSlaPolicyInputDto,
  ): Promise<SlaPolicyOutputDto> {
    assertPlatformPermission(operator, 'settings:manage');

    const policy = SlaPolicy.create(input);
    await assertScopeIsFree(this.policiesRepository, policy);
    await this.policiesRepository.save(policy);

    const output = toSlaPolicyOutput(policy);

    await this.audit.record({
      actor: operator,
      action: 'support.sla_policy.created',
      subjectType: 'SLA_POLICY',
      subjectId: policy.id,
      after: output,
    });

    return output;
  }
}
