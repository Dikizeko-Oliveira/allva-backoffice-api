import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  AcceptOrganizationInvitationInputDto,
  AcceptOrganizationInvitationOutputDto,
} from '../dtos';
import {
  OrganizationInvitation,
  OrganizationUser,
} from 'src/modules/organizations/domain/entities';
import {
  OrganizationInvitationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { BruteForceProtectionService } from 'src/modules/security/application';

export type AcceptInvitationContext = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class AcceptOrganizationInvitationUseCase {
  private readonly logger = new Logger(
    AcceptOrganizationInvitationUseCase.name,
  );

  // Single generic error used for every token-related failure so that the
  // endpoint cannot be used to enumerate valid tokens or leak invitation state
  // (expired vs revoked vs already accepted vs wrong recipient).
  private invalidInvitation(): BadRequestException {
    return new BadRequestException({
      code: 'INVITATION_INVALID',
      message: 'Invitation is invalid, expired or has already been used',
    });
  }

  constructor(
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
    private readonly bruteForce: BruteForceProtectionService,
  ) {}

  async execute(
    input: AcceptOrganizationInvitationInputDto,
    accountId: string,
    context: AcceptInvitationContext = {},
  ): Promise<AcceptOrganizationInvitationOutputDto> {
    const bruteForceKey = {
      scope: 'invitation_accept' as const,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      accountId,
    };

    // Token-guessing protection on top of the route-level throttle.
    await this.bruteForce.assertNotLocked(bruteForceKey);

    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const tokenHash = OrganizationInvitation.hashToken(input.token);

    const invitation =
      await this.invitationsRepository.findByTokenHash(tokenHash);

    // Generic failure for missing/expired/revoked/already-accepted (replay).
    if (!invitation || !invitation.isPending()) {
      this.logger.warn(
        `invitation.accept_failed reason=invalid_token accountId=${accountId}`,
      );
      // Records `invitation.failed` and feeds the token brute-force counter.
      await this.bruteForce.registerFailure(bruteForceKey);
      throw this.invalidInvitation();
    }

    // The accepting account must own the invited email address.
    if (account.email.trim().toLowerCase() !== invitation.email) {
      this.logger.warn(
        `invitation.accept_failed reason=email_mismatch invitationId=${invitation.id} accountId=${accountId}`,
      );
      await this.bruteForce.registerFailure(bruteForceKey);
      throw this.invalidInvitation();
    }

    // Multi-org: only block if the account already holds a live membership in
    // THIS organization. A previously REMOVED membership is reactivated instead
    // of inserting a duplicate (which the (org, account) unique key forbids).
    const existingMembership =
      await this.organizationUsersRepository.findByOrganizationIdAndAccountId(
        invitation.organizationId,
        accountId,
      );

    let organizationUser = existingMembership;

    if (existingMembership && existingMembership.status !== 'REMOVED') {
      throw new BadRequestException({
        code: 'ACCOUNT_ALREADY_IN_ORGANIZATION',
        message: 'Account already belongs to this organization',
      });
    }

    if (existingMembership) {
      existingMembership.updateRole(invitation.role);
      existingMembership.activate();
      await this.organizationUsersRepository.update(existingMembership);
    } else {
      organizationUser = OrganizationUser.create({
        organizationId: invitation.organizationId,
        accountId,
        role: invitation.role,
        status: 'ACTIVE',
      });

      await this.organizationUsersRepository.save(organizationUser);
    }

    // Mark accepted to prevent any subsequent replay of the same token.
    invitation.accept();
    await this.invitationsRepository.update(invitation);

    this.logger.log(
      `invitation.accepted invitationId=${invitation.id} organizationId=${invitation.organizationId} accountId=${accountId} role=${invitation.role}`,
    );

    await this.auditLog.record({
      event: 'member.accepted',
      entityType: 'organization_user',
      entityId: organizationUser!.id,
      actorId: accountId,
      organizationId: invitation.organizationId,
      metadata: { invitationId: invitation.id, role: invitation.role },
    });

    return {
      organizationId: invitation.organizationId,
      organizationUserId: organizationUser!.id,
      role: invitation.role,
    };
  }
}
