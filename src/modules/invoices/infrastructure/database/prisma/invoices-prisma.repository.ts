import { Injectable } from '@nestjs/common';
import { Invoice } from 'src/modules/invoices/domain/entities';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { Plan, PlanFeature } from 'src/modules/plans/domain/entities';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class InvoicesPrismaRepository implements InvoicesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  /** Typed delegate. This was `(this.prisma as any).invoice`, a workaround that
   *  outlived its reason — the generated client has `invoice`, and the cast was
   *  switching off type checking across every read and write here. */
  private get invoiceDelegate() {
    return this.prisma.invoice;
  }

  async save(invoice: Invoice): Promise<void> {
    await this.invoiceDelegate.create({
      data: {
        id: invoice.id,
        accountId: invoice.accountId,
        subscriptionId: invoice.subscriptionId,
        contractId: invoice.contractId,
        planId: invoice.planId,
        number: invoice.number,
        provider: invoice.provider,
        status: invoice.status,
        amount: invoice.amount,
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        dueAt: invoice.dueAt,
        externalReference: invoice.externalReference,
        externalInvoiceId: invoice.externalInvoiceId,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
      },
    });
  }

  async update(invoice: Invoice): Promise<void> {
    await this.invoiceDelegate.update({
      where: { id: invoice.id },
      data: {
        status: invoice.status,
        amount: invoice.amount,
        currency: invoice.currency,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        dueAt: invoice.dueAt,
        externalReference: invoice.externalReference,
        externalInvoiceId: invoice.externalInvoiceId,
      },
    });
  }

  async updateStatus(invoice: Invoice): Promise<void> {
    await this.invoiceDelegate.update({
      where: { id: invoice.id },
      data: {
        status: invoice.status,
      },
    });
  }

  async findById(id: string): Promise<Invoice | null> {
    const record = await this.invoiceDelegate.findUnique({
      where: { id },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async findByExternalInvoiceId(
    externalInvoiceId: string,
  ): Promise<Invoice | null> {
    const record = await this.invoiceDelegate.findUnique({
      where: { externalInvoiceId },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async listByContractId(contractId: string): Promise<Invoice[]> {
    const records = await this.invoiceDelegate.findMany({
      where: { contractId },
      orderBy: { periodStart: 'asc' },
    });

    return records.map((record) => this.toDomain(record));
  }

  async findLatestBySubscriptionId(
    subscriptionId: string,
  ): Promise<Invoice | null> {
    const record = await this.invoiceDelegate.findFirst({
      where: { subscriptionId },
      orderBy: { periodEnd: 'desc' },
    });

    if (!record) return null;

    return this.toDomain(record);
  }

  async listByAccountId(accountId: string, since?: Date): Promise<Invoice[]> {
    const records = await this.invoiceDelegate.findMany({
      where: {
        accountId,
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      include: {
        plan: { include: { features: { orderBy: { sortOrder: 'asc' } } } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((record) =>
      this.toDomain(
        record,
        record.plan ? this.toDomainPlan(record.plan) : undefined,
      ),
    );
  }

  private toDomain(
    record: {
      id: string;
      accountId: string;
      subscriptionId: string | null;
      contractId?: string | null;
      planId: string;
      provider: 'STRIPE' | 'MANUAL';
      amount: { toString(): string } | number;
      currency: string;
      periodStart: Date;
      periodEnd: Date;
      dueAt: Date | null;
      externalReference: string | null;
      externalInvoiceId: string | null;
      status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELED' | 'EXPIRED';
      number: string;
      updatedAt: Date;
      createdAt: Date;
    },
    plan?: Plan,
  ): Invoice {
    return Invoice.restore({
      id: record.id,
      accountId: record.accountId,
      subscriptionId: record.subscriptionId,
      contractId: record.contractId ?? null,
      planId: record.planId,
      provider: record.provider,
      amount: Number(record.amount),
      currency: record.currency,
      periodStart: record.periodStart,
      periodEnd: record.periodEnd,
      dueAt: record.dueAt ?? undefined,
      externalReference: record.externalReference ?? undefined,
      externalInvoiceId: record.externalInvoiceId ?? undefined,
      status: record.status,
      number: record.number,
      updatedAt: record.updatedAt,
      createdAt: record.createdAt,
      plan,
    });
  }

  private toDomainPlan(record: {
    id: string;
    name: string;
    amount: number | null;
    amountAnnual: number | null;
    type: string;
    trialDays: number | null;
    stripePriceId: string | null;
    stripePriceIdAnnual: string | null;
    createdAt: Date;
    features: Array<{
      id: string;
      key: string;
      name: string;
      enabled: boolean;
      value: string | null;
      description: string | null;
      sortOrder: number;
      landingHighlight: boolean;
      createdAt: Date;
      updatedAt: Date;
    }>;
  }): Plan {
    return Plan.restore({
      id: record.id,
      name: record.name,
      amount: record.amount ?? 0,
      amountAnnual: record.amountAnnual,
      type: record.type as 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE',
      trialDays: record.trialDays,
      stripePriceId: record.stripePriceId,
      stripePriceIdAnnual: record.stripePriceIdAnnual,
      createdAt: record.createdAt,
      features: record.features.map((feature) =>
        PlanFeature.restore({
          id: feature.id,
          key: feature.key,
          name: feature.name,
          enabled: feature.enabled,
          value: feature.value,
          description: feature.description,
          sortOrder: feature.sortOrder,
          landingHighlight: feature.landingHighlight,
          createdAt: feature.createdAt,
          updatedAt: feature.updatedAt,
        }),
      ),
    });
  }
}
