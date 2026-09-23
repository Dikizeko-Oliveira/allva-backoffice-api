import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { Invoice } from 'src/modules/invoices/domain/entities';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { OrganizationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { EnterpriseContract } from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import {
  buildBillingSchedule,
  resolveDueDate,
} from 'src/modules/contracts/domain/billing-schedule';
import {
  ContractInvoiceView,
  toContractInvoiceView,
} from '../contract-invoice.presenter';

/**
 * A emissão das cobranças de um contrato.
 *
 * Sem provedor no caminho: a Allva emite, o cliente paga no banco. A **baixa**
 * mora em `SettleContractInvoiceUseCase` — as duas se parecem por mexerem em
 * fatura, mas esta calcula um cronograma e aquela move o estado do contrato.
 */
@Injectable()
export class IssueContractInvoiceUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly invoices: InvoicesRepositoryInterface,
    private readonly organizations: OrganizationsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  /**
   * Emite a próxima cobrança do cronograma.
   *
   * Emitir é explícito, e não automático, na v1: quem decide que chegou a hora
   * de faturar é o operador, olhando o contrato. Um job que emitisse sozinho
   * teria de acertar também os casos de aditivo no meio do mês e de contrato
   * suspenso — e errar cobrança é o erro caro deste módulo.
   *
   * A próxima é a primeira do cronograma que ainda não saiu. Contar as
   * emitidas, em vez de olhar a data, é o que torna a operação repetível sem
   * duplicar: chamar duas vezes no mesmo dia emite a segunda parcela, não a
   * mesma de novo.
   */
  async issueNext(
    contractId: string,
    actorId: string,
  ): Promise<ContractInvoiceView> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const contract = await this.load(contractId);

    if (!contract.organizationId) {
      /**
       * Sem organização não há a quem cobrar: a fatura precisa de um titular, e
       * ele nasce no provisionamento. Emitir antes produziria uma cobrança que
       * ninguém recebe.
       */
      throw new ConflictException({
        code: 'CONTRACT_NOT_ACTIVATED',
        message: 'Activate the contract before issuing invoices',
      });
    }

    if (contract.status === 'CANCELED') {
      throw new ConflictException({
        code: 'CONTRACT_CANCELED',
        message: 'A canceled contract cannot be invoiced',
      });
    }

    const schedule = buildBillingSchedule({
      startsAt: contract.startsAt,
      endsAt: contract.endsAt,
      billingInterval: contract.billingInterval,
      billingAmount: contract.billingAmount,
      setupFeeAmount: contract.setupFeeAmount,
    });

    const issued = await this.invoices.listByContractId(contract.id);
    const next = schedule[issued.length];

    if (!next) {
      throw new ConflictException({
        code: 'CONTRACT_FULLY_INVOICED',
        message: 'Every scheduled charge of this contract has been issued',
      });
    }

    const organization = await this.organizations.findById(
      contract.organizationId,
    );

    if (!organization) {
      throw new ConflictException({
        code: 'CONTRACT_ORGANIZATION_NOT_FOUND',
        message: 'The organization this contract provisioned no longer exists',
      });
    }

    const now = new Date();
    const invoice = Invoice.forContract({
      // A empresa é a devedora, mas cobrança chega a uma pessoa: o titular.
      accountId: organization.ownerId,
      contractId: contract.id,
      planId: contract.planId,
      // `ENT-2026-0012/03` — o extrato se lê ao lado do contrato que o gerou.
      number: `${contract.contractNumber}/${String(issued.length + 1).padStart(2, '0')}`,
      amount: next.amount,
      currency: contract.currency,
      periodStart: next.periodStart,
      periodEnd: next.periodEnd,
      dueAt: resolveDueDate(now, contract.paymentTerms),
    });

    await this.invoices.save(invoice);

    return toContractInvoiceView(invoice);
  }

  async listInvoices(
    contractId: string,
    actorId: string,
  ): Promise<ContractInvoiceView[]> {
    await this.platformRole.assertPermission(actorId, 'billing:read');

    await this.load(contractId);

    return (await this.invoices.listByContractId(contractId)).map(
      toContractInvoiceView,
    );
  }

  private async load(id: string): Promise<EnterpriseContract> {
    const contract = await this.contracts.findById(id);

    if (!contract) {
      throw new NotFoundException({
        code: 'CONTRACT_NOT_FOUND',
        message: 'Contract not found',
      });
    }

    return contract;
  }
}
