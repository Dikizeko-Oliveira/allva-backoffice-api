import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import {
  SendOrganizationInvitationInputDto,
  SendOrganizationInvitationOutputDto,
} from '../dtos';
import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import {
  OrganizationInvitationsRepositoryInterface,
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { rankOf } from 'src/modules/organizations/domain/rbac';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { OrganizationContext } from '../organization-context.resolver';
import { SeatLimitService } from 'src/modules/organizations/application/services/seat-limit.service';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';

/**
 * A tela do frontend que recebe o convidado (`app/invite/accept`).
 *
 * Era `organization-invitation`, rota que não existe lá: todo convite enviado
 * abria um 404. É esta tela que preserva o token através de login e cadastro,
 * então o link precisa cair exatamente nela.
 */
export const INVITATION_ACCEPT_PATH = 'invite/accept';

/**
 * Quem pode convidar é decidido **antes** daqui, pelo `OrganizationAccessGuard`
 * com `members:invite`, sobre o contexto que o middleware resolveu: participação
 * ativa na organização selecionada.
 *
 * O caso de uso resolvia a organização de novo, a partir da conta, e essa segunda
 * resolução não olhava o status: sem `X-Organization-Id`, uma participação
 * BLOCKED ou congelada voltava do repositório e passava pela checagem de papel.
 * Um ADMIN bloqueado continuava convidando.
 */
@Injectable()
export class SendOrganizationInvitationUseCase {
  private readonly logger = new Logger(SendOrganizationInvitationUseCase.name);

  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly auditLog: AuditLogService,
    private readonly seatLimit: SeatLimitService,
    private readonly appUrl: AppUrlService,
  ) {}

  async execute(
    input: SendOrganizationInvitationInputDto,
    actor: OrganizationContext,
  ): Promise<SendOrganizationInvitationOutputDto> {
    const role = input.role ?? 'MEMBER';

    /**
     * A mesma regra de `UpdateOrganizationUserRoleUseCase`: ninguém concede um
     * papel de rank igual ou maior que o próprio.
     *
     * Sem ela o convite era o desvio da troca de papel. Um ADMIN proibido de
     * promover alguém a ADMIN convidava um e-mail novo como ADMIN e chegava ao
     * mesmo lugar — a tela escondia a opção, a API aceitava.
     */
    if (rankOf(role) >= rankOf(actor.role)) {
      throw new ForbiddenException({
        code: 'ROLE_ESCALATION_NOT_ALLOWED',
        message:
          'You cannot invite with a role equal to or higher than your own',
      });
    }

    const [inviter, organization] = await Promise.all([
      this.accountsRepository.findById(actor.accountId),
      this.organizationsRepository.findById(actor.organizationId),
    ]);

    if (!inviter) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    if (!organization) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    const email = input.email.trim().toLowerCase();

    const accountByEmail = await this.accountsRepository.findByEmail(email);

    if (accountByEmail && accountByEmail.id === organization.ownerId) {
      throw new BadRequestException({
        code: 'OWNER_ALREADY_IN_ORGANIZATION',
        message: 'Organization owner cannot be invited',
      });
    }

    if (accountByEmail) {
      const existingOrganizationMember =
        await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
          organization.id,
          accountByEmail.id,
        );

      // An already-removed membership may be re-invited.
      if (
        existingOrganizationMember &&
        existingOrganizationMember.status !== 'REMOVED'
      ) {
        throw new BadRequestException({
          code: 'ACCOUNT_ALREADY_IN_ORGANIZATION',
          message: 'Account already belongs to organization',
        });
      }
    }

    const existingPendingInvitation =
      await this.invitationsRepository.findPendingByEmailAndOrganizationId(
        email,
        organization.id,
      );

    if (existingPendingInvitation) {
      throw new BadRequestException({
        code: 'INVITATION_ALREADY_PENDING',
        message: 'There is already a pending invitation for this email',
      });
    }

    // Enforce the plan seat limit only once the invite is known to be a genuine
    // new seat (not a duplicate/existing member handled above).
    await this.seatLimit.assertCanInvite(organization.id);

    // Cryptographically secure token: the raw value is sent to the invitee and
    // never persisted; only its SHA-256 hash is stored.
    const { token, tokenHash } = OrganizationInvitation.generateToken();

    const invitation = OrganizationInvitation.create({
      organizationId: organization.id,
      email,
      role,
      invitedBy: actor.accountId,
      tokenHash,
    });

    await this.invitationsRepository.save(invitation);

    this.logger.log(
      `invitation.created id=${invitation.id} organizationId=${organization.id} email=${email} role=${invitation.role} invitedBy=${actor.accountId}`,
    );

    await this.auditLog.record({
      event: 'member.invited',
      entityType: 'organization_invitation',
      entityId: invitation.id,
      actorId: actor.accountId,
      organizationId: organization.id,
      metadata: { email, role: invitation.role },
    });

    const invitationUrl = this.appUrl.pathTo(
      `${INVITATION_ACCEPT_PATH}?token=${encodeURIComponent(token)}`,
    );

    const { subject, html, text } = await this.emailTemplates.render(
      'organization-invitation',
      {
        name: email,
        inviter: inviter.name,
        url: invitationUrl,
        orgName: organization.name,
      },
    );

    await this.emailSender.send({ to: email, subject, html, text });

    return { id: invitation.id, expiresAt: invitation.expiresAt };
  }
}
