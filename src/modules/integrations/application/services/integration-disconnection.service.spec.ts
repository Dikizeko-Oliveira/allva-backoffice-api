import { IntegrationDisconnectionService } from './integration-disconnection.service';

/**
 * Desconectar uma credencial, pelo pedido do usuário ou pela exclusão da
 * organização — o mesmo passo a passo.
 *
 * O que se protege é a assimetria entre as duas falhas: a plataforma recusar a
 * revogação **não** mantém a credencial conectada aqui; já uma falha de escrita
 * volta contada, para quem chamou tentar de novo.
 */

type FakeIntegration = {
  id: string;
  organizationId: string;
  providerType: string;
  status: string;
  markDisconnected: jest.Mock;
};

function credencial(id: string, status = 'CONNECTED'): FakeIntegration {
  const integration: FakeIntegration = {
    id,
    organizationId: 'org-1',
    providerType: 'META',
    status,
    markDisconnected: jest.fn(),
  };
  integration.markDisconnected.mockImplementation(() => {
    integration.status = 'DISCONNECTED';
  });
  return integration;
}

function harness(
  options: {
    integrations?: FakeIntegration[];
    revokeFails?: boolean;
    updateFailsFor?: string;
  } = {},
) {
  const integrations = options.integrations ?? [credencial('int-1')];
  const revokeToken = jest.fn(async () => {
    if (options.revokeFails) throw new Error('500 da plataforma');
  });

  const integrationsRepository = {
    update: jest.fn(async (integration: FakeIntegration) => {
      if (integration.id === options.updateFailsFor) {
        throw new Error('db timeout');
      }
    }),
    listByOrganizationId: jest
      .fn()
      .mockResolvedValue(
        integrations.map((integration) => ({ integration, adAccounts: [] })),
      ),
  };
  const adAccountsRepository = {
    markIntegrationAccountsDisconnected: jest.fn(async () => undefined),
  };
  const providers = { for: jest.fn(() => ({ revokeToken })) };
  const audit = { record: jest.fn(async () => undefined) };

  const service = new IntegrationDisconnectionService(
    integrationsRepository as never,
    adAccountsRepository as never,
    providers as never,
    audit as never,
  );

  for (const level of ['warn', 'error'] as const) {
    jest
      .spyOn((service as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return {
    service,
    integrations,
    revokeToken,
    integrationsRepository,
    adAccountsRepository,
    audit,
  };
}

describe('desconexão de credencial', () => {
  it('revoga na plataforma, desconecta, desvincula as contas e registra na trilha', async () => {
    const h = harness();
    const [integration] = h.integrations;

    const result = await h.service.disconnect(integration as never, {
      actorId: 'acc-1',
      reason: 'USER_REQUEST',
    });

    expect(result).toEqual({ revoked: true });
    expect(h.revokeToken).toHaveBeenCalledTimes(1);
    expect(integration.markDisconnected).toHaveBeenCalled();
    expect(
      h.adAccountsRepository.markIntegrationAccountsDisconnected,
    ).toHaveBeenCalledWith('int-1');
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'integration.disconnected',
        entityId: 'int-1',
        actorId: 'acc-1',
        organizationId: 'org-1',
        metadata: { platform: 'META', reason: 'USER_REQUEST', revoked: true },
      }),
    );
  });

  it('a plataforma recusar a revogação não mantém a credencial conectada', async () => {
    const h = harness({ revokeFails: true });
    const [integration] = h.integrations;

    const result = await h.service.disconnect(integration as never, {
      actorId: 'acc-1',
      reason: 'USER_REQUEST',
    });

    expect(result).toEqual({ revoked: false });
    expect(integration.markDisconnected).toHaveBeenCalled();
    // A trilha é onde se descobre um token que continuou valendo do outro lado.
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ revoked: false }),
      }),
    );
  });
});

describe('desconexão das credenciais de uma organização excluída', () => {
  it('desconecta toda credencial ainda viva e pula a já desconectada', async () => {
    const h = harness({
      integrations: [
        credencial('int-1'),
        credencial('int-2', 'TOKEN_EXPIRED'),
        credencial('int-3', 'DISCONNECTED'),
      ],
    });

    const outcome = await h.service.disconnectOrganization('org-1', 'acc-1');

    expect(outcome).toEqual({ disconnected: 2, revoked: 2, failed: 0 });
    expect(h.revokeToken).toHaveBeenCalledTimes(2);
    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'acc-1',
        metadata: expect.objectContaining({ reason: 'ORGANIZATION_DELETED' }),
      }),
    );
  });

  it('uma credencial que falha não impede as outras, e a falha volta contada', async () => {
    const h = harness({
      integrations: [credencial('int-1'), credencial('int-2')],
      updateFailsFor: 'int-1',
    });

    const outcome = await h.service.disconnectOrganization('org-1', 'acc-1');

    expect(outcome).toEqual({ disconnected: 1, revoked: 1, failed: 1 });
    expect(
      h.adAccountsRepository.markIntegrationAccountsDisconnected,
    ).toHaveBeenCalledWith('int-2');
  });
});
