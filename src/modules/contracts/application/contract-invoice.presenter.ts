import { Invoice } from 'src/modules/invoices/domain/entities';

/** A fatura de contrato como o operador a lê no extrato. */
export type ContractInvoiceView = {
  id: string;
  number: string;
  status: string;
  amount: number;
  currency: string;
  periodStart: string;
  periodEnd: string;
  dueAt: string | null;
};

export function toContractInvoiceView(invoice: Invoice): ContractInvoiceView {
  return {
    id: invoice.id,
    number: invoice.number,
    status: invoice.status,
    amount: invoice.amount,
    currency: invoice.currency,
    periodStart: invoice.periodStart.toISOString(),
    periodEnd: invoice.periodEnd.toISOString(),
    dueAt: invoice.dueAt?.toISOString() ?? null,
  };
}
