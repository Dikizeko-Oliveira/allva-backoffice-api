import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EntitlementGuard } from './entitlement.guard';
import { ACCESS_STATUSES_METADATA } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { AUTHENTICATED_ONLY_METADATA } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';

function buildHarness(options: {
  role: string;
  metadata: Record<string, unknown>;
}) {
  const reflector = {
    getAllAndOverride: jest.fn((key: string) => options.metadata[key]),
  } as unknown as Reflector;

  const resolver = {
    resolve: jest.fn().mockResolvedValue({
      accessStatus: 'ALLOWED',
      onFreeTrial: false,
    }),
  };

  const request = {
    user: {
      id: 'acc-1',
      email: 'x@allva.com.br',
      sessionId: 's',
      role: options.role,
    },
  };

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return {
    guard: new EntitlementGuard(reflector, resolver as never),
    context,
    resolver,
  };
}

const PRODUCT_ROUTE = {
  [ACCESS_STATUSES_METADATA]: ['ALLOWED', 'GRACE_PERIOD'],
};

describe('EntitlementGuard — conta de plataforma no produto do cliente', () => {
  it('recusa operador em rota de produto, antes de resolver assinatura', async () => {
    // Antes a resposta era BLOCKED com redirectTo para o checkout — o front
    // mandava o operador assinar um plano.
    const h = buildHarness({ role: 'ALLVA_OPERATOR', metadata: PRODUCT_ROUTE });

    await expect(h.guard.canActivate(h.context)).rejects.toMatchObject({
      response: { code: 'PLATFORM_ACCOUNT_NOT_CUSTOMER' },
    });
    expect(h.resolver.resolve).not.toHaveBeenCalled();
  });

  it('deixa o operador usar rota de conta (@AuthenticatedOnly)', async () => {
    // Perfil, preferências e avatar são usados pelo próprio backoffice.
    const h = buildHarness({
      role: 'ALLVA_ADMIN',
      metadata: { ...PRODUCT_ROUTE, [AUTHENTICATED_ONLY_METADATA]: true },
    });

    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
  });

  it('cliente segue pela checagem de assinatura normal', async () => {
    const h = buildHarness({ role: 'USER', metadata: PRODUCT_ROUTE });

    await expect(h.guard.canActivate(h.context)).resolves.toBe(true);
    expect(h.resolver.resolve).toHaveBeenCalled();
  });
});
