import { Invoice } from '../entities/invoices.entity';

export abstract class InvoicesRepositoryInterface {
  abstract save(invoice: Invoice): Promise<void>;
  abstract update(invoice: Invoice): Promise<void>;
  abstract updateStatus(invoice: Invoice): Promise<void>;
  abstract findById(id: string): Promise<Invoice | null>;
  abstract findByExternalInvoiceId(
    externalInvoiceId: string,
  ): Promise<Invoice | null>;
  abstract findLatestBySubscriptionId(
    subscriptionId: string,
  ): Promise<Invoice | null>;
  abstract listByAccountId(accountId: string, since?: Date): Promise<Invoice[]>;

  /**
   * O extrato de um contrato, da mais antiga para a mais nova.
   *
   * A ordem importa para a emissão: é contando o que já saiu que ela sabe qual
   * é a próxima cobrança do cronograma, e emitir fora de ordem produziria
   * períodos sobrepostos.
   */
  abstract listByContractId(contractId: string): Promise<Invoice[]>;
}
