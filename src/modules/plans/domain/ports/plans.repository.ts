import { Plan } from '../entities/plan.entity';

export abstract class PlansRepositoryInterface {
  abstract save(plan: Plan): Promise<void>;
  abstract findByType(
    type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE',
  ): Promise<Plan | null>;
  abstract findById(id: string): Promise<Plan | null>;
  abstract listAll(): Promise<Plan[]>;
}
