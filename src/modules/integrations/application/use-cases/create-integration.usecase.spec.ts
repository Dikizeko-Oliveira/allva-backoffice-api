import { NotFoundException } from '@nestjs/common';
import { CreateIntegrationUseCase } from './create-integration.usecase';

/**
 * O defeito que este teste tranca.
 *
 * `integrations.organization_id` é NOT NULL desde a migração ads-first (D6), mas
 * o use case procurava a organização e aceitava não achar: o `organizationId`
 * ia `undefined` para a entidade, o repositório gravava `?? null` sob um
 * `as never`, e o INSERT falhava **dentro do callback do OAuth** — com o
 * consentimento já concedido na plataforma e nada gravado do nosso lado.
 *
 * Uma conta self-serve criada antes do provisionamento no cadastro cai
 * exatamente nesse caso. Por isso a organização aqui é garantida, não procurada.
 */

function buildHarness(
  options: {
    account?: { id: string; name: string; email: string } | null;
    existingIntegration?: {
      id: string;
      organizationId: string;
      updateTokens: jest.Mock;
    } | null;
  } = {},
) {
  const account =
    options.account === undefined
      ? { id: 'acc-1', name: 'Dikezeko Oliveira', email: 'dike@empresa.com' }
      : options.account;

  const integrationsRepository = {
    findByAccountAndProvider: jest
      .fn()
      .mockResolvedValue(options.existingIntegration ?? null),
    save: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };

  const organizationProvisioning = {
    ensureForAccount: jest
      .fn()
      .mockResolvedValue({ organizationId: 'org-1', created: true }),
  };

  const accountsRepository = {
    findById: jest.fn().mockResolvedValue(account),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  /**
   * A credencial existente passa a ser procurada dentro da organização que vai
   * recebê-la, e a organização escolhida é revalidada antes de valer — por isso
   * o resolvedor de escopo entra no harness.
   */
  const ownerScope = {
    resolveForAccount: jest
      .fn()
      .mockImplementation((accountId: string, selected?: string) =>
        Promise.resolve({
          accountId,
          organizationId: selected ?? 'org-1',
        }),
      ),
    findIntegrationForOwner: jest
      .fn()
      .mockResolvedValue(options.existingIntegration ?? null),
  };

  return {
    useCase: new CreateIntegrationUseCase(
      integrationsRepository as never,
      organizationProvisioning as never,
      accountsRepository as never,
      auditLog as never,
      ownerScope as never,
    ),
    integrationsRepository,
    ownerScope,
    organizationProvisioning,
    auditLog,
  };
}

const input = {
  name: 'Meta Ads',
  provider: 'meta',
  providerType: 'META' as never,
  accessToken: 'token',
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

describe('conectar uma plataforma de mídia', () => {
  it('grava a credencial com a organização garantida', async () => {
    const h = buildHarness();

    await h.useCase.execute(input, 'acc-1');

    expect(h.organizationProvisioning.ensureForAccount).toHaveBeenCalledWith({
      accountId: 'acc-1',
      accountName: 'Dikezeko Oliveira',
      accountEmail: 'dike@empresa.com',
      source: 'integration',
    });

    const [saved] = h.integrationsRepository.save.mock.calls[0];
    expect(saved.organizationId).toBe('org-1');
  });

  it('provisiona a organização de uma conta que ainda não tem nenhuma', async () => {
    // O caso que quebrava: conta anterior ao provisionamento no cadastro.
    const h = buildHarness();
    h.organizationProvisioning.ensureForAccount.mockResolvedValue({
      organizationId: 'org-nova',
      created: true,
    });

    await h.useCase.execute(input, 'acc-1');

    expect(h.integrationsRepository.save.mock.calls[0][0].organizationId).toBe(
      'org-nova',
    );
  });

  it('a organização precede a gravação — nada é salvo se ela falhar', async () => {
    const h = buildHarness();
    h.organizationProvisioning.ensureForAccount.mockRejectedValue(
      new Error('db down'),
    );

    await expect(h.useCase.execute(input, 'acc-1')).rejects.toThrow('db down');
    expect(h.integrationsRepository.save).not.toHaveBeenCalled();
  });

  it('registra integration.connected com a organização da credencial', async () => {
    const h = buildHarness();

    await h.useCase.execute(input, 'acc-1');

    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'integration.connected',
        organizationId: 'org-1',
      }),
    );
  });

  it('reconectar reusa a integração e a organização que ela já tem', async () => {
    const existing = {
      id: 'int-1',
      organizationId: 'org-antiga',
      updateTokens: jest.fn(),
    };
    const h = buildHarness({ existingIntegration: existing });

    const result = await h.useCase.execute(input, 'acc-1');

    expect(result).toEqual({ id: 'int-1' });
    expect(existing.updateTokens).toHaveBeenCalledTimes(1);
    expect(h.integrationsRepository.save).not.toHaveBeenCalled();
    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'integration.reconnected',
        organizationId: 'org-antiga',
      }),
    );
  });

  it('recusa uma conta inexistente antes de provisionar qualquer coisa', async () => {
    const h = buildHarness({ account: null });

    await expect(h.useCase.execute(input, 'acc-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.organizationProvisioning.ensureForAccount).not.toHaveBeenCalled();
  });
});
