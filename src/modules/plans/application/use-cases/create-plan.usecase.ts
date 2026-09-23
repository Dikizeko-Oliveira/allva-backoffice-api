import { assertPlatformPermission } from 'src/modules/accounts/application/platform-authorization';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CreatePlanInputDto,
  CreatePlanOutputDto,
  SubscriptionPlanType,
} from '../dtos';
import { Plan } from 'src/modules/plans/domain/entities';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';

@Injectable()
export class CreatePlanUseCase {
  constructor(
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
  ) {}

  async execute(
    input: CreatePlanInputDto,
    accountId: string,
  ): Promise<CreatePlanOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    /**
     * `settings:manage` — só administração.
     *
     * O catálogo não é cobrança de um cliente: é o que a página de preços
     * vende e o que toda guarda de plano deriva (`ENFORCED_FEATURE_KEYS` lê o
     * mesmo catálogo). Criar um plano muda o produto para todo mundo, e é
     * configuração da plataforma, não ato do financeiro.
     */
    assertPlatformPermission(account, 'settings:manage');

    const existingPlan = await this.plansRepository.findByType(input.type);

    if (existingPlan) {
      throw new ConflictException({
        code: 'PLAN_TYPE_ALREADY_EXISTS',
        message: 'A plan with this type already exists',
      });
    }

    if (input.type === SubscriptionPlanType.FREE && input.amount !== 0) {
      throw new BadRequestException({
        code: 'FREE_PLAN_AMOUNT_INVALID',
        message: 'Free plan amount must be zero',
      });
    }

    if (input.type !== SubscriptionPlanType.FREE && input.amount <= 0) {
      throw new BadRequestException({
        code: 'PAID_PLAN_AMOUNT_INVALID',
        message: 'Paid plans must have an amount greater than zero',
      });
    }

    const plan = Plan.create({
      name: input.name,
      amount: input.amount,
      amountAnnual: input.amountAnnual,
      type: input.type,
      trialDays: input.trialDays,
      stripePriceId: input.stripePriceId,
      stripePriceIdAnnual: input.stripePriceIdAnnual,
      features: input.features,
    });

    await this.plansRepository.save(plan);

    return { id: plan.id };
  }
}
