import { Injectable } from '@nestjs/common';
import { AccountProviderIdentity } from 'src/modules/auth/domain/entities';
import { AccountProviderIdentitiesRepositoryInterface } from 'src/modules/auth/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AccountProviderIdentitiesPrismaRepository implements AccountProviderIdentitiesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findByProviderSubject(
    provider: string,
    providerSubject: string,
  ): Promise<AccountProviderIdentity | null> {
    const record = await this.prisma.accountProviderIdentity.findUnique({
      where: {
        provider_providerSubject: {
          provider,
          providerSubject,
        },
      },
    });

    if (!record) {
      return null;
    }

    return AccountProviderIdentity.restore({
      id: record.id,
      accountId: record.accountId,
      provider: record.provider,
      providerSubject: record.providerSubject,
      email: record.email ?? undefined,
      createdAt: record.createdAt,
    });
  }

  async save(identity: AccountProviderIdentity): Promise<void> {
    await this.prisma.accountProviderIdentity.create({
      data: {
        id: identity.id,
        accountId: identity.accountId,
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        email: identity.email ?? null,
        createdAt: identity.createdAt,
      },
    });
  }
}
