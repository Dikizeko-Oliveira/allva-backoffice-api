import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { EnterpriseContract } from 'src/modules/contracts/domain/entities';
import { EnterpriseContractsRepositoryInterface } from 'src/modules/contracts/domain/ports/enterprise-contracts.repository';
import {
  ContractInvoiceView,
  toContractInvoiceView,
} from '../contract-invoice.presenter';

/**
 * A baixa manual — e o que ela desbloqueia no contrato.
 *
 * Endpoint e não webhook porque não há ninguém do outro lado para avisar: o
 * contrato Enterprise é pago por boleto, PIX ou transferência, e quem sabe que
 * o dinheiro entrou é o financeiro da Allva.
 *
 * Caso de uso separado da emissão de propósito. As duas operações se parecem
 * por mexerem em fatura, mas a emissão calcula um cronograma e a baixa move o
 * **estado do contrato** — e é essa segunda parte que faz dela mais que um
 * `UPDATE status`.
 */
@Injectable()
export class SettleContractInvoiceUseCase {
  constructor(
    private readonly contracts: EnterpriseContractsRepositoryInterface,
    private readonly invoices: InvoicesRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    invoiceId: string,
    actorId: string,
  ): Promise<ContractInvoiceView> {
    await this.platformRole.assertPermission(actorId, 'billing:manage');

    const invoice = await this.invoices.findById(invoiceId);

    if (!invoice) {
      throw new NotFoundException({
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }

    if (!invoice.contractId) {
      /**
       * Fatura de autoatendimento se baixa pelo webhook da Stripe, que é a
       * fonte da verdade do pagamento. Marcá-la à mão faria o produto acreditar
       * num dinheiro que o provedor não confirmou.
       */
      throw new ConflictException({
        code: 'INVOICE_NOT_MANUALLY_SETTLEABLE',
        message: 'Only contract invoices are settled by hand',
      });
    }

    if (!invoice.canTransitionTo('PAID')) {
      throw new ConflictException({
        code: 'INVOICE_STATUS_NOT_ALLOWED',
        message: `An invoice in ${invoice.status} cannot be settled`,
      });
    }

    invoice.updateStatus('PAID');
    await this.invoices.updateStatus(invoice);

    const contract = await this.contracts.findById(invoice.contractId);
    if (contract) await this.applyPaymentToContract(contract);

    return toContractInvoiceView(invoice);
  }

  /**
   * O que a entrada de dinheiro muda no contrato.
   *
   * Duas consequências. Um contrato que esperava o pré-pagamento
   * (`activateOnSignature: false`) abre o acesso agora. E um suspenso **por
   * inadimplência** reabre sozinho — mas um suspenso pelo operador não:
   * `reactivateOnPayment` recusa, e é o que impede um pagamento de desfazer uma
   * decisão humana sobre quebra de contrato ou fraude.
   */
  private async applyPaymentToContract(
    contract: EnterpriseContract,
  ): Promise<void> {
    if (contract.status === 'PENDING_ACTIVATION') {
      contract.confirmFirstPayment();
      await this.contracts.update(contract);
      return;
    }

    if (contract.reactivateOnPayment()) {
      await this.contracts.update(contract);
    }
  }
}
