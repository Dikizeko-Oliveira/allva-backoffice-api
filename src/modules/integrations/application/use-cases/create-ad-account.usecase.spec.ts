import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateAdAccountUseCase } from './create-ad-account.usecase';

/**
 * Regressão do isolamento entre organizações (FI-1).
 *
 * `findById(integrationId)` não filtrava por escopo, e o `organizationId` da
 * conta criada era copiado da integração encontrada: qualquer usuário
 * autenticado que enviasse o id de outro tenant escrevia dentro da organização
 * alheia, consumindo a cota do plano dela e passando a sincronizar com a
 * credencial dela.
 */
function buildHarness(integrationOrganizationId = 'org-do-atacante') {
  const integration = {
    id: 'int-1',
    organizationId: integrationOrganizationId,
    accountId: 'acc-dona',
  };

  const integrationsRepository = {
    findById: jest.fn().mockResolvedValue(integration),
  };

  const adAccountsRepository = { save: jest.fn().mockResolvedValue(undefined) };

  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'acc-atacante' }),
  };

  const ownerScope = {
    resolveForAccount: jest.fn().mockResolvedValue({
      accountId: 'acc-atacante',
      organizationId: 'org-do-atacante',
    }),
    isIntegrationOwned: jest
      .fn()
      .mockImplementation(
        (owner, i) => i.organizationId === owner.organizationId,
      ),
  };

  return {
    useCase: new CreateAdAccountUseCase(
      adAccountsRepository as never,
      integrationsRepository as never,
      accountsRepository as never,
      ownerScope as never,
    ),
    adAccountsRepository,
    ownerScope,
  };
}

const input = {
  integrationId: 'int-1',
  provider: 'meta',
  externalAccountId: 'act_123',
  name: 'Conta',
  currency: 'BRL',
  timezone: 'America/Sao_Paulo',
} as never;

describe('criar conta de anúncios manualmente', () => {
  it('recusa a credencial de outra organização sem confirmar que ela existe', async () => {
    const h = buildHarness('org-da-vitima');

    await expect(h.useCase.execute(input, 'acc-atacante')).rejects.toThrow(
      NotFoundException,
    );

    // Nada é escrito na organização alheia.
    expect(h.adAccountsRepository.save).not.toHaveBeenCalled();
  });

  it('aceita a credencial do próprio escopo', async () => {
    const h = buildHarness('org-do-atacante');

    const result = await h.useCase.execute(input, 'acc-atacante');

    expect(result.id).toBeDefined();
    expect(h.adAccountsRepository.save).toHaveBeenCalledTimes(1);
  });

  it('recusa plataforma fora do vocabulário antes de tocar no banco', async () => {
    const h = buildHarness('org-do-atacante');

    await expect(
      h.useCase.execute(
        { ...(input as object), provider: 'orkut' } as never,
        'acc-atacante',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(h.adAccountsRepository.save).not.toHaveBeenCalled();
  });

  it('normaliza o slug em minúsculas em vez de deixar o enum estourar no banco', async () => {
    const h = buildHarness('org-do-atacante');

    await h.useCase.execute(input, 'acc-atacante');

    expect(h.adAccountsRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'META' }),
    );
  });
});
