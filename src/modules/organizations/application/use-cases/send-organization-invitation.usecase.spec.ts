import { SendOrganizationInvitationUseCase } from './send-organization-invitation.usecase';
import type { OrganizationContext } from '../organization-context.resolver';
import type { OrganizationRole } from 'src/modules/organizations/domain/rbac';

function build(options: { actorRole?: OrganizationRole } = {}) {
  const actor: OrganizationContext = {
    organizationId: 'org-1',
    accountId: 'actor-1',
    membershipId: 'membership-1',
    role: options.actorRole ?? 'OWNER',
  };

  const organizationsRepository = {
    findById: jest.fn().mockResolvedValue({
      id: 'org-1',
      ownerId: 'owner-1',
      name: 'Empresa X',
    }),
  };
  const organizationUsersRepository = {
    findByOrganizationIdAndAccountId: jest.fn().mockResolvedValue(null),
  };
  const invitationsRepository = {
    findPendingByEmailAndOrganizationId: jest.fn().mockResolvedValue(null),
    save: jest.fn().mockResolvedValue(undefined),
  };
  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'actor-1', name: 'Beto' }),
    findByEmail: jest.fn().mockResolvedValue(null),
  };
  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const emailTemplates = {
    render: jest
      .fn()
      .mockResolvedValue({ subject: 'Convite', html: '<p></p>', text: '' }),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };
  const seatLimit = { assertCanInvite: jest.fn().mockResolvedValue(undefined) };
  const appUrl = {
    pathTo: jest.fn((path: string) => `https://app.example.com/${path}`),
  };

  return {
    actor,
    useCase: new SendOrganizationInvitationUseCase(
      organizationsRepository as never,
      organizationUsersRepository as never,
      invitationsRepository as never,
      accountsRepository as never,
      emailSender as never,
      emailTemplates as never,
      auditLog as never,
      seatLimit as never,
      appUrl as never,
    ),
    organizationsRepository,
    invitationsRepository,
    emailSender,
    emailTemplates,
  };
}

describe('SendOrganizationInvitationUseCase', () => {
  describe('o link do e-mail', () => {
    it('cai em /invite/accept, a tela que existe no frontend', async () => {
      // Era `/organization-invitation`: todo convite enviado abria um 404.
      const h = build();

      await h.useCase.execute({ email: 'ana@empresa.com' } as never, h.actor);

      const [template, props] = h.emailTemplates.render.mock.calls[0];

      expect(template).toBe('organization-invitation');
      expect(props.url).toMatch(
        /^https:\/\/app\.example\.com\/invite\/accept\?token=[A-Za-z0-9_-]+$/,
      );
    });
  });

  describe('anti-escalação', () => {
    it('recusa ADMIN convidando ADMIN — o mesmo que a troca de papel recusa', async () => {
      const h = build({ actorRole: 'ADMIN' });

      await expect(
        h.useCase.execute(
          { email: 'novo@empresa.com', role: 'ADMIN' } as never,
          h.actor,
        ),
      ).rejects.toMatchObject({
        response: { code: 'ROLE_ESCALATION_NOT_ALLOWED' },
      });

      // Recusa antes de qualquer efeito: nada gravado, nada enviado.
      expect(h.invitationsRepository.save).not.toHaveBeenCalled();
      expect(h.emailSender.send).not.toHaveBeenCalled();
    });

    it('deixa ADMIN convidar abaixo do próprio rank', async () => {
      const h = build({ actorRole: 'ADMIN' });

      await h.useCase.execute(
        { email: 'novo@empresa.com', role: 'FINANCE' } as never,
        h.actor,
      );

      expect(h.invitationsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'FINANCE' }),
      );
    });

    it('deixa OWNER convidar ADMIN', async () => {
      const h = build({ actorRole: 'OWNER' });

      await h.useCase.execute(
        { email: 'novo@empresa.com', role: 'ADMIN' } as never,
        h.actor,
      );

      expect(h.invitationsRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ role: 'ADMIN' }),
      );
    });
  });

  it('convida na organização do contexto resolvido, não numa derivada da conta', async () => {
    const h = build();

    await h.useCase.execute({ email: 'ana@empresa.com' } as never, h.actor);

    expect(h.organizationsRepository.findById).toHaveBeenCalledWith('org-1');
    expect(h.invitationsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', role: 'MEMBER' }),
    );
  });
});
