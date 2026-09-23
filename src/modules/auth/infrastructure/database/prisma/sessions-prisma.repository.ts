import { Injectable } from '@nestjs/common';
import { Session } from 'src/modules/auth/domain/entities/session.entity';
import { SessionsRepositoryInterface } from 'src/modules/auth/domain/ports/sessions.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class SessionsPrismaRepository implements SessionsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(session: Session): Promise<void> {
    await this.prisma.session.create({
      data: {
        id: session.id,
        accountId: session.accountId,
        refreshTokenHash: session.refreshTokenHash,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        revokedAt: session.revokedAt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      },
    });
  }

  async update(session: Session): Promise<void> {
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refreshTokenHash: session.refreshTokenHash,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        revokedAt: session.revokedAt,
        updatedAt: session.updatedAt,
      },
    });
  }

  async findById(id: string): Promise<Session | null> {
    const record = await this.prisma.session.findUnique({
      where: { id },
    });

    if (!record) return null;

    return Session.restore({
      id: record.id,
      accountId: record.accountId,
      refreshTokenHash: record.refreshTokenHash,
      expiresAt: record.expiresAt,
      ipAddress: record.ipAddress ?? undefined,
      userAgent: record.userAgent ?? undefined,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async findByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<Session | null> {
    const record = await this.prisma.session.findFirst({
      where: { refreshTokenHash },
    });

    if (!record) return null;

    return Session.restore({
      id: record.id,
      accountId: record.accountId,
      refreshTokenHash: record.refreshTokenHash,
      expiresAt: record.expiresAt,
      ipAddress: record.ipAddress ?? undefined,
      userAgent: record.userAgent ?? undefined,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  }

  async revokeAllByAccountId(accountId: string): Promise<void> {
    const now = new Date();
    await this.prisma.session.updateMany({
      where: {
        accountId,
        revokedAt: null,
      },
      data: {
        revokedAt: now,
        updatedAt: now,
      },
    });
  }

  async listAllByAccountId(accountId: string): Promise<Session[]> {
    const sessions = await this.prisma.session.findMany({
      where: {
        accountId,
        revokedAt: null,
      },
    });

    return sessions.map((record) =>
      Session.restore({
        id: record.id,
        accountId: record.accountId,
        refreshTokenHash: record.refreshTokenHash,
        expiresAt: record.expiresAt,
        ipAddress: record.ipAddress ?? undefined,
        userAgent: record.userAgent ?? undefined,
        revokedAt: record.revokedAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }),
    );
  }
}
