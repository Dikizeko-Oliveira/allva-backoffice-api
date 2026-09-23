import { Injectable, NotFoundException } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SlaPoliciesRepositoryInterface } from 'src/modules/support/domain/ports';
import { SlaPolicyOutputDto, UpdateSlaPolicyInputDto } from '../dtos';
import { assertScopeIsFree } from '../sla-policy-scope';
import { toSlaPolicyOutput } from '../support.presenter';

@Injectable()
export class UpdateSlaPolicyUseCase {
  constructor(
    private readonly policiesRepository: SlaPoliciesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
    input: UpdateSlaPolicyInputDto,
  ): Promise<SlaPolicyOutputDto> {
    assertPlatformPermission(operator, 'settings:manage');

    const policy = await this.policiesRepository.findById(id);

    if (!policy) {
      throw new NotFoundException({
        code: 'SLA_POLICY_NOT_FOUND',
        message: 'SLA policy not found',
      });
    }

    const before = toSlaPolicyOutput(policy);

    policy.update(input);
    await assertScopeIsFree(this.policiesRepository, policy);
    await this.policiesRepository.update(policy);

    const after = toSlaPolicyOutput(policy);

    await this.audit.record({
      actor: operator,
      action: 'support.sla_policy.updated',
      subjectType: 'SLA_POLICY',
      subjectId: id,
      before,
      after,
    });

    return after;
  }
}
