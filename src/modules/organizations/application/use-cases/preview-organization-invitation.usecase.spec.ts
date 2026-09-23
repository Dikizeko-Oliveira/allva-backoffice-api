import { OrganizationInvitation } from 'src/modules/organizations/domain/entities';
import { PreviewOrganizationInvitationUseCase } from './preview-organization-invitation.usecase';

function buildInvitation(overrides: Partial<{
  email: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}> = {}) {
  return OrganizationInvitation.restore({
    id: 'invitation-1',
    organizationId: 'org-1',
    email: overrides.email ?? 'convidado@empresa.com',
    role: 'MEMBER',
    tokenHash: 'irrelevant-here',
    invitedBy: 'account-1',
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    acceptedAt: overrides.acceptedAt ?? null,
    revokedAt: overrides.revokedAt ?? null,
    createdAt: new Date(),
  });
}

function buildHarness(invitation: OrganizationInvitation | null) {
  const invitationsRepository = {
    findByTokenHash: jest.fn().mockResolvedValue(invitation),
  };
  const organizationsRepository = {
    findById: jest.fn().mockResolvedValue({ name: 'Acme Ltda' }),
  };

  const useCase = new PreviewOrganizationInvitationUseCase(
    invitationsRepository as never,
    organizationsRepository as never,
  );

  return { useCase, invitationsRepository, organizationsRepository };
}

/**
 * Mesma recusa genérica do aceite (`INVITATION_INVALID`), para os quatro
 * motivos de falha - token errado, expirado, revogado ou já aceito. Uma rota
 * pública sem exigir autenticação não pode devolver pistas diferentes; senão
 * vira um oráculo para testar tokens colhidos em outro lugar.
 */
describe('PreviewOrganizationInvitationUseCase', () => {
  it('devolve e-mail e nome da organização para um convite pendente', async () => {
    const h = buildHarness(buildInvitation());

    const result = await h.useCase.execute('raw-token');

    expect(result).toEqual({
      email: 'convidado@empresa.com',
      organizationName: 'Acme Ltda',
    });
  });

  it('recusa quando o token não corresponde a nenhum convite', async () => {
    const h = buildHarness(null);

    await expect(h.useCase.execute('raw-token')).rejects.toMatchObject({
      response: { code: 'INVITATION_INVALID' },
    });
  });

  it('recusa convite expirado com o mesmo código genérico', async () => {
    const h = buildHarness(
      buildInvitation({ expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(h.useCase.execute('raw-token')).rejects.toMatchObject({
      response: { code: 'INVITATION_INVALID' },
    });
  });

  it('recusa convite já aceito com o mesmo código genérico', async () => {
    const h = buildHarness(buildInvitation({ acceptedAt: new Date() }));

    await expect(h.useCase.execute('raw-token')).rejects.toMatchObject({
      response: { code: 'INVITATION_INVALID' },
    });
  });

  it('recusa convite revogado com o mesmo código genérico', async () => {
    const h = buildHarness(buildInvitation({ revokedAt: new Date() }));

    await expect(h.useCase.execute('raw-token')).rejects.toMatchObject({
      response: { code: 'INVITATION_INVALID' },
    });
  });

  it('recusa token vazio sem consultar o repositório', async () => {
    const h = buildHarness(null);

    await expect(h.useCase.execute('')).rejects.toMatchObject({
      response: { code: 'INVITATION_INVALID' },
    });
    expect(h.invitationsRepository.findByTokenHash).not.toHaveBeenCalled();
  });

  it('nome vazio se a organização não for encontrada, sem recusar', async () => {
    const h = buildHarness(buildInvitation());
    h.organizationsRepository.findById.mockResolvedValue(null);

    const result = await h.useCase.execute('raw-token');

    expect(result.organizationName).toBe('');
  });
});
