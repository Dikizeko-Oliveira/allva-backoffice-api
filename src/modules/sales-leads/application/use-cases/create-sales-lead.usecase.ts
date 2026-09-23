import { Injectable } from '@nestjs/common';
import { CreateSalesLeadInputDto, CreateSalesLeadOutputDto } from '../dtos';
import { SalesLead } from '../../domain/entities';
import { SalesLeadsRepositoryInterface } from '../../domain/ports';

@Injectable()
export class CreateSalesLeadUseCase {
  constructor(
    private readonly salesLeadsRepository: SalesLeadsRepositoryInterface,
  ) {}

  /**
   * Creates a sales lead. The accountId is resolved by the backend from the
   * authenticated session (or null for anonymous leads) and is never taken
   * from the request body.
   */
  async execute(
    input: CreateSalesLeadInputDto,
    accountId: string | null,
  ): Promise<CreateSalesLeadOutputDto> {
    const salesLead = SalesLead.create({
      accountId,
      companyName: input.companyName,
      workEmail: input.workEmail,
      fullName: input.fullName,
      phone: input.phone,
      estimatedMonthlySpend: input.estimatedMonthlySpend,
      teamSize: input.teamSize,
      platforms: input.platforms,
      notes: input.notes,
      desiredPlan: input.desiredPlan,
      source: input.source,
    });

    await this.salesLeadsRepository.save(salesLead);

    return { id: salesLead.id, status: salesLead.status };
  }
}
