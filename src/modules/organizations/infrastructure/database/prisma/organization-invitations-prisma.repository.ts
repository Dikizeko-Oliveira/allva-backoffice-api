import { Injectable } from '@nestjs/common';
import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import { OrganizationInvitationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class OrganizationInvitationsPrismaRepository implements OrganizationInvitationsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  private toDomain(record: {
    id: string;
    organizationId: string;
    email: string;
    role: string;
    tokenHash: string;
    invitedBy: string;
    expiresAt: Date;
    acceptedAt: Date | null;
    revokedAt: Date | null;
    createdAt: Date;
    deletedAt: Date | null;
  }): OrganizationInvitation {
    return OrganizationInvitation.restore({
      id: record.id,
      organizationId: record.organizationId,
      email: record.email,
      role: record.role as
        | 'ADMIN'
        | 'FINANCE'
        | 'ANALYST'
        | 'MEMBER'
        | 'VIEWER',
      tokenHash: record.tokenHash,
      invitedBy: record.invitedBy,
      expiresAt: record.expiresAt,
      acceptedAt: record.acceptedAt,
      revokedAt: record.revokedAt,
      createdAt: record.createdAt,
      deletedAt: record.deletedAt,
    });
  }

  async save(invitation: OrganizationInvitation): Promise<void> {
    await this.prisma.organizationInvitation.create({
      data: {
        id: invitation.id,
        organizationId: invitation.organizationId,
        email: invitation.email,
        role: invitation.role,
        tokenHash: invitation.tokenHash,
        invitedBy: invitation.invitedBy,
        expiresAt: invitation.expiresAt,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        createdAt: invitation.createdAt,
      },
    });
  }

  async update(invitation: OrganizationInvitation): Promise<void> {
    await this.prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: {
        role: invitation.role,
        acceptedAt: invitation.acceptedAt,
        revokedAt: invitation.revokedAt,
        deletedAt: invitation.deletedAt,
      },
    });
  }

  async findById(id: string): Promise<OrganizationInvitation | null> {
    const record = await this.prisma.organizationInvitation.findUnique({
      where: { id },
    });

    return record ? this.toDomain(record) : null;
  }

  async findByTokenHash(
    tokenHash: string,
  ): Promise<OrganizationInvitation | null> {
    const record = await this.prisma.organizationInvitation.findUnique({
      where: { tokenHash },
    });

    return record ? this.toDomain(record) : null;
  }

  async findPendingByEmailAndOrganizationId(
    email: string,
    organizationId: string,
  ): Promise<OrganizationInvitation | null> {
    const record = await this.prisma.organizationInvitation.findFirst({
      where: {
        email: email.trim().toLowerCase(),
        organizationId,
        acceptedAt: null,
        revokedAt: null,
        deletedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
    });

    return record ? this.toDomain(record) : null;
  }

  async listByOrganizationId(
    organizationId: string,
  ): Promise<OrganizationInvitation[]> {
    // Soft-deleted (revoked) invitations are excluded from listings.
    const records = await this.prisma.organizationInvitation.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });

    return records.map((record) => this.toDomain(record));
  }
}
