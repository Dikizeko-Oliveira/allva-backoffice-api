import { Injectable } from '@nestjs/common';
import { Plan } from 'src/modules/plans/domain/entities';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';

@Injectable()
export class ListPlansUseCase {
  constructor(private readonly plansRepository: PlansRepositoryInterface) {}

  async execute(): Promise<Plan[]> {
    const plans = await this.plansRepository.listAll();

    const order: Record<'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE', number> = {
      FREE: 0,
      STARTER: 1,
      PRO: 2,
      ENTERPRISE: 3,
    };

    return plans.sort((a, b) => order[a.type] - order[b.type]);
  }
}
