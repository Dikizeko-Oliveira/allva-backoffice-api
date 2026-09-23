import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { SlaPoliciesRepositoryInterface } from 'src/modules/support/domain/ports';
import { SlaPolicyOutputDto } from '../dtos';
import { toSlaPolicyOutput } from '../support.presenter';

@Injectable()
export class ListSlaPoliciesUseCase {
  constructor(
    private readonly policiesRepository: SlaPoliciesRepositoryInterface,
  ) {}

  async execute(operator: Operator): Promise<SlaPolicyOutputDto[]> {
    assertPlatformPermission(operator, 'support:read');

    const policies = await this.policiesRepository.list();
    return policies.map(toSlaPolicyOutput);
  }
}
