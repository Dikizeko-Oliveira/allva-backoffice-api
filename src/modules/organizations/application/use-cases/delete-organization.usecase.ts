import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import { DeleteOrganizationOutputDto } from '../dtos';

@Injectable()
export class DeleteOrganizationUseCase {
  private readonly logger = new Logger(DeleteOrganizationUseCase.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEventBus,
    private readonly requestContext: RequestContextService,
  ) {}

  async execute(
    actor: OrganizationContext,
  ): Promise<DeleteOrganizationOutputDto> {
    // Only the canonical owner may delete the organization. The route guard
    // restricts to OWNER role; we additionally require the canonical ownerId.
    if (actor.role !== 'OWNER') {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_DELETE_ORGANIZATION',
        message: 'Only the organization owner can delete the organization',
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

    if (organization.ownerId !== actor.accountId) {
      throw new ForbiddenException({
        code: 'NOT_ALLOWED_TO_DELETE_ORGANIZATION',
        message: 'Only the organization owner can delete the organization',
      });
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      // Soft delete the organization (never a physical delete).
      await tx.organization.update({
        where: { id: organization.id },
        data: { deletedAt: now },
      });

      // Cascade the soft delete to memberships so nothing keeps pointing at a
      // deleted org and no orphaned access remains.
      await tx.organizationUser.updateMany({
        where: { organizationId: organization.id, deletedAt: null },
        data: { status: 'REMOVED', deletedAt: now, updatedAt: now },
      });

      // Invalidate any still-pending invitations to this org.
      await tx.organizationInvitation.updateMany({
        where: {
          organizationId: organization.id,
          deletedAt: null,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { revokedAt: now, deletedAt: now },
      });

      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          event: 'organization.deleted',
          entityType: 'organization',
          entityId: organization.id,
          actorId: actor.accountId,
          organizationId: organization.id,
          metadata: { name: organization.name },
        },
      });
    });

    /**
     * As credenciais das plataformas saem **depois** do commit, e por evento.
     *
     * Depois: revogação não tem volta, e revogar dentro de uma transação que
     * se desfizesse deixaria a organização de pé sem acesso às próprias contas.
     *
     * Por evento: quem sabe revogar é `integrations`, que importa este módulo,
     * e chamá-lo daqui fecharia ciclo. Sem isto, excluir a organização — ou
     * encerrar a conta do titular, que passa por aqui — deixava tokens vivos
     * de acesso a mídia paga sem dono nenhum.
     */
    this.events.emitFrom(
      {
        ...createRootJobContext(this.requestContext.getCorrelationId()),
        organizationId: organization.id,
      },
      'organization.deleted',
      { actorId: actor.accountId },
    );

    this.logger.log(
      `organization.deleted organizationId=${organization.id} by=${actor.accountId}`,
    );

    return { id: organization.id, deletedAt: now };
  }
}
