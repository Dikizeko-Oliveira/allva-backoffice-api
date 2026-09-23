import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import { TransferOrganizationOwnershipOutputDto } from '../dtos';

/** Role the outgoing owner is demoted to after a transfer. */
const DEMOTED_OWNER_ROLE = 'ADMIN';

@Injectable()
export class TransferOrganizationOwnershipUseCase {
  private readonly logger = new Logger(
    TransferOrganizationOwnershipUseCase.name,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    actor: OrganizationContext,
    newOwnerAccountId: string,
  ): Promise<TransferOrganizationOwnershipOutputDto> {
    // Defence in depth: the route guard already restricts this to OWNER, but we
    // never trust that alone — only the canonical owner may transfer ownership.
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_TRANSFER_OWNERSHIP',
        message: 'Only the organization owner can transfer ownership',
      });
    }

    if (newOwnerAccountId === actor.accountId) {
      throw new ForbiddenException({
        code: 'CANNOT_TRANSFER_TO_SELF',
        message: 'Ownership is already held by this account',
      });
    }

    const organization = await this.prisma.organization.findFirst({
      where: { id: actor.organizationId, deletedAt: null },
    });

    if (!organization) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    // The acting account must be the canonical owner of THIS organization.
    if (organization.ownerId !== actor.accountId) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_TRANSFER_OWNERSHIP',
        message: 'Only the organization owner can transfer ownership',
      });
    }

    // The new owner must be a live (non-removed) member of the same org. This is
    // the multi-tenant isolation check: ownership can only move to an insider.
    const targetMembership = await this.prisma.organizationUser.findUnique({
      where: {
        organizationId_accountId: {
          organizationId: actor.organizationId,
          accountId: newOwnerAccountId,
        },
      },
    });

    if (
      !targetMembership ||
      targetMembership.status === 'REMOVED' ||
      targetMembership.deletedAt
    ) {
      throw new NotFoundException({
        code: 'ORGANIZATION_USER_NOT_FOUND',
        message: 'Target member not found in this organization',
      });
    }

    if (targetMembership.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'TARGET_MEMBER_NOT_ACTIVE',
        message: 'Ownership can only be transferred to an active member',
      });
    }

    const ownerMembership = await this.prisma.organizationUser.findUnique({
      where: {
        organizationId_accountId: {
          organizationId: actor.organizationId,
          accountId: actor.accountId,
        },
      },
    });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // 1. Move canonical ownership.
      await tx.organization.update({
        where: { id: organization.id },
        data: { ownerId: newOwnerAccountId },
      });

      // 2. Promote the target to OWNER.
      await tx.organizationUser.update({
        where: { id: targetMembership.id },
        data: { role: 'OWNER', status: 'ACTIVE', updatedAt: now },
      });

      // 3. Demote the previous owner to ADMIN (ownership is exclusive).
      if (ownerMembership) {
        await tx.organizationUser.update({
          where: { id: ownerMembership.id },
          data: { role: DEMOTED_OWNER_ROLE, updatedAt: now },
        });
      }

      // 4. Audit the transfer inside the same transaction.
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          event: 'ownership.transferred',
          entityType: 'organization',
          entityId: organization.id,
          actorId: actor.accountId,
          organizationId: organization.id,
          metadata: {
            previousOwnerAccountId: actor.accountId,
            newOwnerAccountId,
          },
        },
      });
    });

    this.logger.log(
      `ownership.transferred organizationId=${organization.id} from=${actor.accountId} to=${newOwnerAccountId}`,
    );

    return {
      organizationId: organization.id,
      newOwnerAccountId,
      previousOwnerAccountId: actor.accountId,
    };
  }
}
