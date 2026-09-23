import { Injectable } from '@nestjs/common';
import { Payment } from 'src/modules/subscriptions/domain/entities';
import { PaymentsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';

@Injectable()
export class PaymentsPrismaRepository implements PaymentsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  /** Typed delegate. This was `(this.prisma as any).payment` — a workaround
   *  that outlived its reason: the generated client has `payment`, and the cast
   *  was switching off type checking across the whole payments write path. */
  private get paymentDelegate() {
    return this.prisma.payment;
  }

  async save(payment: Payment): Promise<void> {
    await this.paymentDelegate.create({
      data: {
        id: payment.id,
        accountId: payment.accountId,
        subscriptionId: payment.subscriptionId,
        invoiceId: payment.invoiceId,
        provider: payment.provider,
        status: payment.status,
        paymentMethod: payment.paymentMethod,
        amount: payment.amount,
        currency: payment.currency,
        externalReference: payment.externalReference,
        externalPaymentId: payment.externalPaymentId,
        statusDetail: payment.statusDetail,
        metadata: toPrismaJson(payment.metadata),
        rawResponse: toPrismaJson(payment.rawResponse),
        paidAt: payment.paidAt,
        createdAt: payment.createdAt,
        updatedAt: payment.updatedAt,
      },
    });
  }

  async update(payment: Payment): Promise<void> {
    await this.paymentDelegate.update({
      where: { id: payment.id },
      data: {
        status: payment.status,
        paymentMethod: payment.paymentMethod,
        externalPaymentId: payment.externalPaymentId,
        statusDetail: payment.statusDetail,
        metadata: toPrismaJson(payment.metadata),
        rawResponse: toPrismaJson(payment.rawResponse),
        paidAt: payment.paidAt,
      },
    });
  }

  async findById(id: string): Promise<Payment | null> {
    const record = await this.paymentDelegate.findUnique({
      where: { id },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async findByInvoiceId(invoiceId: string): Promise<Payment | null> {
    const record = await this.paymentDelegate.findFirst({
      where: { invoiceId },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async findByExternalReference(
    externalReference: string,
  ): Promise<Payment | null> {
    const record = await this.paymentDelegate.findUnique({
      where: { externalReference },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async findByExternalPaymentId(
    externalPaymentId: string,
  ): Promise<Payment | null> {
    const record = await this.paymentDelegate.findUnique({
      where: { externalPaymentId },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  private toDomain(record: {
    id: string;
    accountId: string;
    subscriptionId: string;
    invoiceId: string;
    // `MANUAL` entrou com a baixa de fatura de contrato: pagamento por boleto
    // ou transferência é pagamento, e o que muda é quem o processou.
    provider: 'STRIPE' | 'MANUAL';
    status:
      | 'PENDING'
      | 'APPROVED'
      | 'AUTHORIZED'
      | 'IN_PROCESS'
      | 'IN_MEDIATION'
      | 'REJECTED'
      | 'CANCELED'
      | 'REFUNDED'
      | 'CHARGED_BACK';
    paymentMethod: 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | null;
    amount: { toString(): string } | number;
    currency: string;
    externalReference: string;
    externalPaymentId: string | null;
    statusDetail: string | null;
    metadata: unknown;
    rawResponse: unknown;
    paidAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): Payment {
    return Payment.restore({
      id: record.id,
      accountId: record.accountId,
      subscriptionId: record.subscriptionId,
      invoiceId: record.invoiceId,
      provider: record.provider,
      status: record.status,
      paymentMethod: record.paymentMethod ?? undefined,
      amount: Number(record.amount),
      currency: record.currency,
      externalReference: record.externalReference,
      externalPaymentId: record.externalPaymentId ?? undefined,
      statusDetail: record.statusDetail ?? undefined,
      metadata:
        record.metadata && typeof record.metadata === 'object'
          ? (record.metadata as Record<string, unknown>)
          : undefined,
      rawResponse:
        record.rawResponse && typeof record.rawResponse === 'object'
          ? (record.rawResponse as Record<string, unknown>)
          : undefined,
      paidAt: record.paidAt ?? undefined,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
