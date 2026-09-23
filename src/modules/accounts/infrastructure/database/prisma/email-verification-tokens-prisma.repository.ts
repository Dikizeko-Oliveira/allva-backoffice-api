import { Injectable } from '@nestjs/common';
import { EmailVerificationToken } from 'src/modules/accounts/domain/entities';
import { EmailVerificationTokensRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class EmailVerificationTokensPrismaRepository implements EmailVerificationTokensRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(token: EmailVerificationToken): Promise<void> {
    await this.prisma.emailVerificationToken.create({
      data: {
        id: token.id,
        accountId: token.accountId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        usedAt: token.usedAt,
        attempts: token.attempts,
        createdAt: token.createdAt,
      },
    });
  }

  async update(token: EmailVerificationToken): Promise<void> {
    await this.prisma.emailVerificationToken.update({
      where: { id: token.id },
      // `attempts` sobe sem o código ser consumido: é a escrita de um palpite
      // errado, e é ela que faz o teto de tentativas existir de fato.
      data: { usedAt: token.usedAt, attempts: token.attempts },
    });
  }

  async findPendingByAccountId(
    accountId: string,
  ): Promise<EmailVerificationToken | null> {
    const record = await this.prisma.emailVerificationToken.findFirst({
      where: { accountId, usedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });

    if (!record) return null;

    return EmailVerificationToken.restore({
      id: record.id,
      accountId: record.accountId,
      tokenHash: record.tokenHash,
      expiresAt: record.expiresAt,
      usedAt: record.usedAt,
      attempts: record.attempts,
      createdAt: record.createdAt,
    });
  }

  async invalidateAllByAccountId(accountId: string): Promise<void> {
    await this.prisma.emailVerificationToken.updateMany({
      where: { accountId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }
}
