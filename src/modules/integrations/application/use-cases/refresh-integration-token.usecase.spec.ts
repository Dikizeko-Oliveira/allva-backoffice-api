import { UnauthorizedException, BadGatewayException } from '@nestjs/common';
import { RefreshIntegrationTokenUseCase } from './refresh-integration-token.usecase';
import { Integration } from 'src/modules/integrations/domain/entities';

/**
 * Regressão do estado que se apagava (FI-4).
 *
 * `markTokenExpired()` gravava `TOKEN_EXPIRED` e `markError()`, na linha
 * seguinte, sobrescrevia para `ERROR`. O estado que diz "reconecte sua conta"
 * nunca chegava ao banco e a integração morria como erro genérico, sem caminho
 * de volta na tela.
 */
function buildIntegration(): Integration {
  return Integration.create({
    accountId: 'acc-1',
    organizationId: 'org-1',
    provider: 'meta',
    providerType: 'META' as never,
    accessToken: 'token',
    expiresAt: new Date(Date.now() + 3600_000),
    name: 'Meta Ads',
  });
}

function buildHarness(failure: unknown) {
  const integrationsRepository = {
    update: jest.fn().mockResolvedValue(undefined),
  };

  const providers = {
    for: jest.fn().mockReturnValue({
      refreshAccessToken: jest.fn().mockRejectedValue(failure),
    }),
  };

  return {
    useCase: new RefreshIntegrationTokenUseCase(
      integrationsRepository as never,
      providers as never,
    ),
    integrationsRepository,
  };
}

describe('renovar credencial da plataforma', () => {
  it('recusa de autorização vira TOKEN_EXPIRED, e a razão sobrevive', async () => {
    const integration = buildIntegration();
    const h = buildHarness(
      new UnauthorizedException({ code: 'INVALID', message: 'invalid_grant' }),
    );

    await expect(
      h.useCase.executeForIntegration(integration),
    ).rejects.toBeDefined();

    expect(integration.status).toBe('TOKEN_EXPIRED');
    expect(integration.syncError).toContain('Token refresh failed');
  });

  it('reconhece a recusa mesmo quando a plataforma a embrulha num 502', async () => {
    const integration = buildIntegration();
    const h = buildHarness(
      new BadGatewayException({
        code: 'META_TOKEN_EXCHANGE_FAILED',
        message: 'OAuthException: Session has been invalidated',
      }),
    );

    await expect(
      h.useCase.executeForIntegration(integration),
    ).rejects.toBeDefined();

    expect(integration.status).toBe('TOKEN_EXPIRED');
  });

  it('falha transitória não manda o usuário reconectar uma conta que está boa', async () => {
    const integration = buildIntegration();
    const h = buildHarness(new Error('socket hang up'));

    await expect(h.useCase.executeForIntegration(integration)).rejects.toThrow(
      'socket hang up',
    );

    expect(integration.status).toBe('ERROR');
  });

  it('markError não rebaixa um TOKEN_EXPIRED já declarado', () => {
    const integration = buildIntegration();

    integration.markTokenExpired('credencial vencida');
    integration.markError('outra coisa falhou depois');

    expect(integration.status).toBe('TOKEN_EXPIRED');
    expect(integration.syncError).toBe('outra coisa falhou depois');
  });
});
