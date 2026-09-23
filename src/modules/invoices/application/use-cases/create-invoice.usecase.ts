import { assertPlatformPermission } from 'src/modules/accounts/application/platform-authorization';
import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateInvoiceInputDto, CreateInvoiceOutputDto } from '../dtos';
import { Invoice } from 'src/modules/invoices/domain/entities';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';

@Injectable()
export class CreateInvoiceUseCase {
  constructor(
    private readonly invoicesRepository: InvoicesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly plansRepository: PlansRepositoryInterface,
  ) {}

  async execute(
    input: CreateInvoiceInputDto,
    actorId: string,
  ): Promise<CreateInvoiceOutputDto> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Actor account not found',
      });
    }

    // 403, e não o 401 que esta cópia devolvia: a sessão é válida, o que falta
    // é capacidade — e 401 manda o cliente para o login.
    assertPlatformPermission(actor, 'billing:manage');

    const targetAccount = await this.accountsRepository.findById(
      input.accountId,
    );

    if (!targetAccount) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const plan = await this.plansRepository.findById(input.planId);

    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_FOUND',
        message: 'Plan not found',
      });
    }

    const invoice = Invoice.create({
      accountId: input.accountId,
      subscriptionId: input.subscriptionId,
      planId: input.planId,
      provider: input.provider as 'STRIPE',
      number: input.number,
      amount: plan.amount ?? 0,
      currency: 'BRL',
      periodStart: new Date(),
      periodEnd: new Date(),
      externalReference: input.externalReference,
    });

    await this.invoicesRepository.save(invoice);

    return { id: invoice.id };
  }
}
