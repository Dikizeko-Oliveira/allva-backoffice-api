import { Injectable } from '@nestjs/common';
import { BillingCard } from 'src/modules/subscriptions/domain/entities';
import { BillingCardsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class BillingCardsPrismaRepository implements BillingCardsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cartão é sempre da Stripe.
   *
   * `MANUAL` entrou no enum do banco com a fatura de contrato, que é paga por
   * boleto ou transferência — e dessas não sobra cartão salvo. A linha com
   * `MANUAL` aqui só existiria por corrupção de dado, e devolvê-la como se
   * fosse um cartão da Stripe faria uma cobrança sair pelo provedor errado.
   */
  private assertStripeCard(provider: 'STRIPE' | 'MANUAL'): 'STRIPE' {
    if (provider !== 'STRIPE') {
      throw new Error(
        `Billing card with non-Stripe provider "${provider}" is not payable`,
      );
    }

    return provider;
  }

  async findById(id: string): Promise<BillingCard | null> {
    const record = await this.prisma.billingCard.findUnique({
      where: { id },
    });

    return record ? this.toDomain(record) : null;
  }

  async findByExternalCardId(
    provider: 'STRIPE',
    externalCardId: string,
  ): Promise<BillingCard | null> {
    const record = await this.prisma.billingCard.findUnique({
      where: {
        provider_externalCardId: {
          provider: provider,
          externalCardId,
        },
      },
    });

    return record ? this.toDomain(record) : null;
  }

  async listByAccountId(accountId: string): Promise<BillingCard[]> {
    const records = await this.prisma.billingCard.findMany({
      where: { accountId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    return records.map((record) => this.toDomain(record));
  }

  async save(card: BillingCard): Promise<void> {
    await this.prisma.billingCard.create({
      data: {
        id: card.id,
        accountId: card.accountId,
        provider: card.provider,
        externalCustomerId: card.externalCustomerId,
        externalCardId: card.externalCardId,
        brand: card.brand,
        paymentMethod: card.paymentMethod,
        firstSixDigits: card.firstSixDigits,
        lastFourDigits: card.lastFourDigits,
        expirationMonth: card.expirationMonth,
        expirationYear: card.expirationYear,
        issuerName: card.issuerName,
        cardholderName: card.cardholderName,
        status: card.status,
        isDefault: card.isDefault,
        createdAt: card.createdAt,
        updatedAt: card.updatedAt,
      },
    });
  }

  async update(card: BillingCard): Promise<void> {
    await this.prisma.billingCard.update({
      where: { id: card.id },
      data: {
        brand: card.brand,
        paymentMethod: card.paymentMethod,
        firstSixDigits: card.firstSixDigits,
        lastFourDigits: card.lastFourDigits,
        expirationMonth: card.expirationMonth,
        expirationYear: card.expirationYear,
        issuerName: card.issuerName,
        cardholderName: card.cardholderName,
        status: card.status,
        isDefault: card.isDefault,
      },
    });
  }

  async clearDefaultForAccount(
    accountId: string,
    provider: 'STRIPE',
  ): Promise<void> {
    await this.prisma.billingCard.updateMany({
      where: {
        accountId,
        provider: provider,
      },
      data: { isDefault: false },
    });
  }

  private toDomain(record: {
    id: string;
    accountId: string;
    provider: 'STRIPE' | 'MANUAL';
    externalCustomerId: string;
    externalCardId: string;
    brand: string | null;
    paymentMethod: 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD' | null;
    firstSixDigits: string | null;
    lastFourDigits: string;
    expirationMonth: number;
    expirationYear: number;
    issuerName: string | null;
    cardholderName: string | null;
    status: 'ACTIVE' | 'REMOVED';
    isDefault: boolean;
    createdAt: Date;
    updatedAt: Date;
  }): BillingCard {
    return BillingCard.restore({
      id: record.id,
      accountId: record.accountId,
      provider: this.assertStripeCard(record.provider),
      externalCustomerId: record.externalCustomerId,
      externalCardId: record.externalCardId,
      brand: record.brand ?? undefined,
      paymentMethod: record.paymentMethod ?? undefined,
      firstSixDigits: record.firstSixDigits ?? undefined,
      lastFourDigits: record.lastFourDigits,
      expirationMonth: record.expirationMonth,
      expirationYear: record.expirationYear,
      issuerName: record.issuerName ?? undefined,
      cardholderName: record.cardholderName ?? undefined,
      status: record.status,
      isDefault: record.isDefault,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }
}
