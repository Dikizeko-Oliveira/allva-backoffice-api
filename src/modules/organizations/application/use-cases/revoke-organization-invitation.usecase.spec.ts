import { RevokeOrganizationInvitationUseCase } from './revoke-organization-invitation.usecase';
import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import type { OrganizationContext } from '../organization-context.resolver';
import type { OrganizationRole } from 'src/modules/organizations/domain/rbac';

type InvitationRole = 'ADMIN' | 'FINANCE' | 'ANALYST' | 'MEMBER' | 'VIEWER';

function build(options: {
  actorRole: OrganizationRole;
  invitationRole: InvitationRole;
  invitationOrganizationId?: string;
}) {
  const actor: OrganizationContext = {
    organizationId: 'org-1',
    accountId: 'actor-1',
    membershipId: 'membership-1',
    role: options.actorRole,
  };

  const invitation = OrganizationInvitation.create({
    organizationId: options.invitationOrganizationId ?? 'org-1',
    email: 'ana@empresa.com',
    invitedBy: 'owner-1',
    tokenHash: 'hash',
    role: options.invitationRole,
  });

  const invitationsRepository = {
    findById: jest.fn().mockResolvedValue(invitation),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    actor,
    invitation,
    invitationsRepository,
    useCase: new RevokeOrganizationInvitationUseCase(
      invitationsRepository as never,
      auditLog as never,
    ),
  };
}

describe('RevokeOrganizationInvitationUseCase', () => {
  it('recusa ADMIN revogando o convite de ADMIN que o OWNER emitiu', async () => {
    const h = build({ actorRole: 'ADMIN', invitationRole: 'ADMIN' });

    await expect(
      h.useCase.execute(h.invitation.id, h.actor),
    ).rejects.toMatchObject({
      response: { code: 'NOT_ALLOWED_TO_REVOKE_INVITATION' },
    });

    expect(h.invitationsRepository.update).not.toHaveBeenCalled();
  });

  it('deixa ADMIN revogar convite abaixo do próprio rank', async () => {
    const h = build({ actorRole: 'ADMIN', invitationRole: 'MEMBER' });

    const result = await h.useCase.execute(h.invitation.id, h.actor);

    expect(result.revokedAt).toBeInstanceOf(Date);
    expect(h.invitationsRepository.update).toHaveBeenCalledTimes(1);
  });

  it('responde NOT_FOUND para convite de outra organização, antes de olhar rank', async () => {
    // Recusar por rank aqui confirmaria que o convite existe noutro tenant.
    const h = build({
      actorRole: 'ADMIN',
      invitationRole: 'ADMIN',
      invitationOrganizationId: 'org-2',
    });

    await expect(
      h.useCase.execute(h.invitation.id, h.actor),
    ).rejects.toMatchObject({ response: { code: 'INVITATION_NOT_FOUND' } });
  });
});
