import { Injectable } from '@nestjs/common';
import { PasswordResetToken } from 'src/modules/auth/domain/entities';
import {
  PasswordHasherInterface,
  PasswordResetTokensRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class PasswordResetTokensPrismaRepository implements PasswordResetTokensRepositoryInterface {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwordHasher: PasswordHasherInterface,
  ) {}

  async create(token: PasswordResetToken): Promise<void> {
    await this.prisma.passwordResetToken.create({
      data: {
        id: token.id,
        accountId: token.accountId,
        tokenHash: token.tokenHash,
        expiresAt: token.expiresAt,
        usedAt: token.usedAt,
        createdAt: token.createdAt,
      },
    });
  }

  async findValidByToken(token: string): Promise<PasswordResetToken | null> {
    const records = await this.prisma.passwordResetToken.findMany({
      where: {
        usedAt: null,
        expiresAt: {
          gt: new Date(),
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    for (const record of records) {
      if (await this.passwordHasher.compare(token, record.tokenHash)) {
        return PasswordResetToken.restore({
          id: record.id,
          accountId: record.accountId,
          tokenHash: record.tokenHash,
          expiresAt: record.expiresAt,
          usedAt: record.usedAt,
          createdAt: record.createdAt,
        });
      }
    }

    return null;
  }

  async invalidate(tokenId: string): Promise<void> {
    await this.prisma.passwordResetToken.update({
      where: { id: tokenId },
      data: {
        usedAt: new Date(),
      },
    });
  }

  async invalidateAllByAccountId(accountId: string): Promise<void> {
    await this.prisma.passwordResetToken.updateMany({
      where: {
        accountId,
        usedAt: null,
      },
      data: {
        usedAt: new Date(),
      },
    });
  }
}
