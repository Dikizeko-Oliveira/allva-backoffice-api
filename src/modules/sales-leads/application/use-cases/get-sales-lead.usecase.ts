import { Injectable, NotFoundException } from '@nestjs/common';
import { SalesLeadOutputDto } from '../dtos';
import { SalesLeadsRepositoryInterface } from '../../domain/ports';
import { toSalesLeadOutput } from '../sales-lead.presenter';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';

@Injectable()
export class GetSalesLeadUseCase {
  constructor(
    private readonly salesLeadsRepository: SalesLeadsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(id: string, actorId: string): Promise<SalesLeadOutputDto> {
    await this.platformRole.assertPermission(actorId, 'leads:read');

    const salesLead = await this.salesLeadsRepository.findById(id);

    if (!salesLead) {
      throw new NotFoundException({
        code: 'SALES_LEAD_NOT_FOUND',
        message: 'Sales lead not found',
      });
    }

    return toSalesLeadOutput(salesLead);
  }
}
