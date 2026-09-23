import { INestApplication } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AccessStatus } from 'src/modules/subscriptions/access/domain/access-status';
import { SubscriptionContextResolver } from 'src/modules/subscriptions/access/application/subscription-context.resolver';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { GetUpgradeSummaryUseCase } from 'src/modules/paywall/application/get-upgrade-summary.usecase';
import { DomainErrorFilter } from 'src/shared/infrastructure/http/errors/domain-error.filter';
import { UpgradeSummaryController } from './upgrade-summary.controller';

const SUMMARY = {
  state: 'READY' as const,
  wasteFound: { amount: 4812.35, currency: 'BRL' },
  avoidableDaily: { amount: 210.4, currency: 'BRL' },
  affectedAds: 23,
  openFindings: 47,
  actionsApplied: 6,
  outcomesImproved: 4,
  outcomesMeasured: 5,
  windowDays: 14,
  asOf: '2026-08-20T03:12:00.000Z',
};

/**
 * Monta a rota com o **guard de verdade**. Substituí-lo por um passa-tudo
 * testaria o controller e não a única coisa que decide se esta feature funciona:
 * a rota abre justamente nos estados em que o produto está fechado.
 */
async function buildApp(accessStatus: AccessStatus) {
  const execute = jest.fn().mockResolvedValue(SUMMARY);

  const moduleRef = await Test.createTestingModule({
    controllers: [UpgradeSummaryController],
    providers: [
      Reflector,
      EntitlementGuard,
      { provide: GetUpgradeSummaryUseCase, useValue: { execute } },
      {
        provide: SubscriptionContextResolver,
        useValue: { resolve: jest.fn().mockResolvedValue({ accessStatus }) },
      },
      { provide: APP_GUARD, useValue: { canActivate: () => true } },
    ],
  }).compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalFilters(new DomainErrorFilter());
  app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'acc-1', email: 'a@b.com', sessionId: 's-1' };
    next();
  });
  await app.init();

  return { app, execute };
}

describe('GET /api/v1/me/upgrade-summary', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it.each<AccessStatus>([
    'PAYMENT_REQUIRED',
    'BLOCKED',
    'GRACE_PERIOD',
    'PENDING_ACTIVATION',
  ])('abre em %s — é onde a tela de contratação roda', async (status) => {
    const built = await buildApp(status);
    app = built.app;

    const response = await request(app.getHttpServer())
      .get('/api/v1/me/upgrade-summary')
      .expect(200);

    expect(response.body).toEqual(SUMMARY);
  });

  it('recusa quem já tem acesso ao produto — esse tem /waste/summary inteiro', async () => {
    const built = await buildApp('ALLOWED');
    app = built.app;

    // `ALLOWED` fora do conjunto exigido cai no ramo de estado inválido do
    // guard, que responde 409 em vez de 403.
    await request(app.getHttpServer())
      .get('/api/v1/me/upgrade-summary')
      .expect(409);

    expect(built.execute).not.toHaveBeenCalled();
  });

  it('exige autenticação', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UpgradeSummaryController],
      providers: [
        Reflector,
        EntitlementGuard,
        {
          provide: GetUpgradeSummaryUseCase,
          useValue: { execute: jest.fn() },
        },
        {
          provide: SubscriptionContextResolver,
          useValue: { resolve: jest.fn() },
        },
        { provide: APP_GUARD, useValue: { canActivate: () => true } },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    await request(app.getHttpServer())
      .get('/api/v1/me/upgrade-summary')
      .expect(401);
  });
});
