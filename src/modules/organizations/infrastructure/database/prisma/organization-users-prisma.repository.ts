import { Injectable } from '@nestjs/common';
import { OrganizationUser } from 'src/modules/organizations/domain/entities';
import { OrganizationUsersRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { OrganizationRole } from 'src/modules/organizations/domain/rbac';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type OrganizationUserRecord = {
  id: string;
  organizationId: string;
  accountId: string;
  status: string;
  frozenAt: Date | null;
  role: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

@Injectable()
export class OrganizationUsersPrismaRepository implements OrganizationUsersRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(record: OrganizationUserRecord): OrganizationUser {
    return OrganizationUser.restore({
      id: record.id,
      organizationId: record.organizationId,
      accountId: record.accountId,
      status: record.status as 'ACTIVE' | 'INVITED' | 'BLOCKED' | 'REMOVED',
      frozenAt: record.frozenAt,
      role: record.role as OrganizationRole,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      deletedAt: record.deletedAt,
    });
  }

  async save(organizationUser: OrganizationUser): Promise<void> {
    await this.prisma.organizationUser.create({
      data: {
        id: organizationUser.id,
        organizationId: organizationUser.organizationId,
        accountId: organizationUser.accountId,
        role: organizationUser.role,
        status: organizationUser.status,
        frozenAt: organizationUser.frozenAt,
        createdAt: organizationUser.createdAt,
        updatedAt: organizationUser.updatedAt,
        deletedAt: organizationUser.deletedAt,
      },
    });
  }

  async update(organizationUser: OrganizationUser): Promise<void> {
    await this.prisma.organizationUser.update({
      where: { id: organizationUser.id },
      data: {
        role: organizationUser.role,
        status: organizationUser.status,
        frozenAt: organizationUser.frozenAt,
        updatedAt: organizationUser.updatedAt,
        deletedAt: organizationUser.deletedAt,
      },
    });
  }

  async findById(id: string): Promise<OrganizationUser | null> {
    const record = await this.prisma.organizationUser.findUnique({
      where: { id },
    });

    return record ? this.toDomain(record) : null;
  }

  async findByAccountId(accountId: string): Promise<OrganizationUser | null> {
    // Prefer an ACTIVE membership; fall back to any membership for legacy
    // owner-centric callers that just need "an" organization for the account.
    const record =
      (await this.prisma.organizationUser.findFirst({
        where: { accountId, status: 'ACTIVE', deletedAt: null },
        orderBy: { createdAt: 'asc' },
      })) ??
      (await this.prisma.organizationUser.findFirst({
        where: { accountId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }));

    return record ? this.toDomain(record) : null;
  }

  async findByOrganizationIdAndAccountId(
    organizationId: string,
    accountId: string,
  ): Promise<OrganizationUser | null> {
    const record = await this.prisma.organizationUser.findUnique({
      where: { organizationId_accountId: { organizationId, accountId } },
    });

    return record ? this.toDomain(record) : null;
  }

  async listByAccountId(accountId: string): Promise<OrganizationUser[]> {
    const records = await this.prisma.organizationUser.findMany({
      where: { accountId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return records.map((record) => this.toDomain(record));
  }

  async listByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationUser[]> {
    // Soft-deleted (removed) memberships are excluded from listings.
    const records = await this.prisma.organizationUser.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return records.map((record) => this.toDomain(record));
  }

  async countActiveOwners(organizationId: string): Promise<number> {
    return this.prisma.organizationUser.count({
      where: {
        organizationId,
        role: 'OWNER',
        status: 'ACTIVE',
        deletedAt: null,
        // O dono nunca é congelado (ver `MembershipFreezeService`), mas contar
        // um congelado aqui faria a proteção de último dono aprovar a saída do
        // único que ainda tem acesso.
        OR: [{ frozenAt: null }, { frozenAt: { gt: new Date() } }],
      },
    });
  }
}
