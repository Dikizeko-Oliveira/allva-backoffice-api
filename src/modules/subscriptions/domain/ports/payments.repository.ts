import { Payment } from '../entities';

export abstract class PaymentsRepositoryInterface {
  abstract save(payment: Payment): Promise<void>;
  abstract update(payment: Payment): Promise<void>;
  abstract findById(id: string): Promise<Payment | null>;
  abstract findByInvoiceId(invoiceId: string): Promise<Payment | null>;
  abstract findByExternalReference(
    externalReference: string,
  ): Promise<Payment | null>;
  abstract findByExternalPaymentId(
    externalPaymentId: string,
  ): Promise<Payment | null>;
}
