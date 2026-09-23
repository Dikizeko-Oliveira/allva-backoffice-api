import { INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { ResponseEnvelopeInterceptor } from 'src/shared/infrastructure/http/envelope/response-envelope.interceptor';
import { DomainErrorFilter } from 'src/shared/infrastructure/http/errors/domain-error.filter';
import { AdsRepositoryInterface } from 'src/modules/ads/domain/ports/ads.repository';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { AdContextRepositoryInterface } from 'src/modules/ads/domain/ports/ad-context.repository';
import { ListAdsUseCase } from 'src/modules/ads/application/use-cases/ad-read-use-cases';
import {
  GetAdAnalysisUseCase,
  GetAdHistoryUseCase,
  GetAdSeriesUseCase,
  GetAdUseCase,
} from 'src/modules/ads/application/use-cases/ad-read-use-cases';
import { AdsController } from './ads.controller';
import { AdContextController } from './ad-context.controller';
import { Reflector } from '@nestjs/core';

const ORGANIZATION = 'org-1';

function adRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ad-1',
    lineageId: 'ad-1',
    name: 'BF25 | Vídeo 15s',
    platform: 'META',
    externalAdId: '238512345',
    observedStatus: 'ACTIVE',
    desiredStatus: null,
    syncState: 'IN_SYNC',
    campaign: { id: 'camp-1', name: 'Black Friday' },
    adSet: { id: 'set-1', name: 'LAL 1%' },
    creative: { id: 'cr-1', thumbnailUrl: null, format: 'VIDEO' },
    dataMaturity: 'MATURE',
    score: {
      value: 38.4,
      confidence: 0.72,
      coverage: 1,
      delta7d: -12.6,
      asOf: new Date('2026-07-30T00:00:00.000Z'),
    },
    waste: { openCount: 0, openAmount: null, avoidableDaily: null, asOf: null },
    archivedAt: null,
    ...overrides,
  };
}

async function buildApp(
  options: { readEnabled?: boolean; organizationId?: string | null } = {},
) {
  const list = jest.fn().mockResolvedValue({
    items: [adRow()],
    hasMore: false,
    excludedByFloor: 0,
  });
  const findDetail = jest.fn().mockResolvedValue({
    ...adRow(),
    accountId: 'acc-1',
    organizationId: ORGANIZATION,
    adAccountId: 'adacc-1',
    observedAsOf: new Date('2026-07-30T00:00:00.000Z'),
    desiredStatusSetAt: null,
    syncStateAt: null,
    lastStructureSyncAt: null,
    lastMetricsSyncAt: null,
    firstSeenAt: new Date('2026-07-01T00:00:00.000Z'),
    lineage: {
      lineageId: 'ad-1',
      originAdId: null,
      originActionExecutionId: null,
      generations: 1,
    },
  });

  const ads = {
    list,
    findDetail,
    findRef: jest.fn().mockResolvedValue(adRow()),
    series: jest.fn().mockResolvedValue([]),
    history: jest.fn().mockResolvedValue([]),
    lineageMembers: jest.fn().mockResolvedValue([adRow()]),
  };

  const moduleRef = await Test.createTestingModule({
    controllers: [AdsController, AdContextController],
    providers: [
      ListAdsUseCase,
      GetAdUseCase,
      GetAdSeriesUseCase,
      GetAdHistoryUseCase,
      GetAdAnalysisUseCase,
      { provide: AdsRepositoryInterface, useValue: ads },
      {
        provide: PlanEntitlementService,
        useValue: {
          // Sem piso: o objeto deste teste é tenancy e envelope, não plano.
          historyFloorFor: jest.fn().mockResolvedValue(null),
        },
      },
      {
        provide: AdContextRepositoryInterface,
        useValue: {
          listCampaigns: jest.fn().mockResolvedValue({ items: [], total: 0 }),
          findCampaign: jest.fn().mockResolvedValue(null),
          listAdSets: jest.fn().mockResolvedValue({ items: [], total: 0 }),
          findAdSet: jest.fn().mockResolvedValue(null),
          listCreatives: jest.fn().mockResolvedValue({
            items: [
              {
                id: 'creative-1',
                externalCreativeId: 'ext-1',
                platform: 'META',
                name: 'Criativo A',
                format: 'VIDEO',
                thumbnailUrl: null,
                contentHash: 'hash-a',
                durationMs: 15_000,
                archivedAt: null,
                lastSyncedAt: new Date(),
                adCount: 3,
              },
            ],
            total: 1,
          }),
          findCreative: jest.fn().mockResolvedValue(null),
        },
      },
      {
        provide: OwnerScopeResolverService,
        useValue: {
          resolveForAccount: jest.fn().mockResolvedValue({
            accountId: 'acc-1',
            organizationId:
              options.organizationId === undefined
                ? ORGANIZATION
                : options.organizationId,
          }),
        },
      },
      {
        provide: EnvService,
        useValue: { get: () => options.readEnabled ?? true },
      },
      // O guard de entitlement não é o objeto do teste; a tenancy é.
      { provide: APP_GUARD, useValue: { canActivate: () => true } },
    ],
  })
    .overrideGuard(EntitlementGuard)
    .useValue({ canActivate: () => true })
    .compile();

  const app: INestApplication = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalInterceptors(
    new ResponseEnvelopeInterceptor(app.get(Reflector)),
  );
  app.useGlobalFilters(new DomainErrorFilter());
  // O decorator @CurrentUser lê `req.user`.
  app.use((req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: 'acc-1' };
    next();
  });
  await app.init();

  return { app, ads };
}

describe('AdsController', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it('devolve a lista envelopada, com asOf e procedência (P7)', async () => {
    ({ app } = await buildApp());

    const response = await request(app.getHttpServer())
      .get('/api/v1/ads')
      .expect(200);

    expect(response.body.data).toHaveLength(1);
    expect(response.body.meta.asOf).toBeDefined();
    expect(response.body.meta.provenance).toBeDefined();
  });

  it('ordena por avoidableDaily quando ninguém pede ordenação', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer()).get('/api/v1/ads').expect(200);

    // O padrão rankeia pelo que dá para interromper hoje, não pelo que já se
    // perdeu — é a diferença entre uma lista acionável e um relatório.
    const [query] = built.ads.list.mock.calls[0];
    expect(query.sortBy).toBe('avoidableDaily');
    expect(query.sortDirection).toBe('desc');
  });

  it('escopa toda leitura pela organização resolvida (§16.7)', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer()).get('/api/v1/ads').expect(200);

    const [query] = built.ads.list.mock.calls[0];
    expect(query.organizationId).toBe(ORGANIZATION);
  });

  it('recusa leitura sem organização selecionada', async () => {
    ({ app } = await buildApp({ organizationId: null }));

    const response = await request(app.getHttpServer())
      .get('/api/v1/ads')
      .expect(403);

    expect(response.body.error.code).toBe('ORGANIZATION_REQUIRED');
  });

  it('rejeita filtro desconhecido em vez de ignorá-lo', async () => {
    ({ app } = await buildApp());

    // `whitelist + forbidNonWhitelisted` não está ligado aqui, mas o DTO tipado
    // é o que impede um filtro inventado de virar `where` silencioso.
    const response = await request(app.getHttpServer())
      .get('/api/v1/ads?scoreBelow=naoNumero')
      .expect(400);

    expect(response.body).toBeDefined();
  });

  /**
   * **Este teste codificava a mentira, e por isso ela sobreviveu dois sprints.**
   *
   * A redação de A2-S2 exigia `status: 'PENDING'` com a razão contendo
   * `'A2-S4'` — e continuou passando depois de A2-S4 entregar as regras e de
   * A2-S9 entregar a rota que as executa. Um teste que fixa o texto de um
   * placeholder transforma o placeholder em contrato.
   *
   * O que ele verifica agora é a propriedade que sempre importou: a seção
   * **distingue** "ainda não analisamos" de "não há problema", e nunca responde
   * 404. `UNAVAILABLE` em vez de `PENDING` porque a análise é sob demanda —
   * `PENDING` prometeria que ela chega sozinha.
   */
  it('/analysis responde 200 e distingue ausência de diagnóstico, nunca 404', async () => {
    ({ app } = await buildApp());

    const response = await request(app.getHttpServer())
      .get('/api/v1/ads/ad-1/analysis')
      .expect(200);

    // "Ainda não analisamos" e "não há problema" levam a decisões opostas.
    expect(response.body.data.creativeAnalysis.status).toBe('UNAVAILABLE');

    const reason = response.body.data.creativeAnalysis.reason as string;

    /**
     * O `reason` diz **onde conseguir a análise**, e diz para quem lê a tela.
     *
     * Este teste exigia a string `/ads/{id}/analyze` — e assim fixava como
     * contrato justamente o defeito: o endpoint não é acionável por quem está
     * no produto, e a única pergunta que a frase precisa responder ficava sem
     * resposta. O contrato é o encaminhamento, não a rota HTTP.
     */
    expect(reason).toMatch(/sob demanda/i);
    expect(reason).toMatch(/Laborat[óo]rio Criativo/i);
    expect(reason).not.toMatch(/POST|\/ads\//);
    // Nenhuma seção pode citar um sprint já entregue como se fosse futuro.
    expect(reason).not.toMatch(/A2-S\d/);
    expect(response.body.data.recommendations.status).toBe('UNAVAILABLE');
  });

  /**
   * **O contrato é o erro tipado, não o nome do sprint.** A redação de A2-S2
   * exigia `'A2-S4'` na remediação, e foi o segundo teste deste arquivo a
   * transformar um placeholder em contrato — o outro fixava a seção
   * `creativeAnalysis`. Os dois sobreviveram às entregas que deveriam tê-los
   * removido, e o gate de `measurement-cycle.spec.ts` agora impede o terceiro.
   *
   * O que a rota deve ao cliente é: código estável, `422` (não `404`, que diria
   * "o anúncio não existe") e uma remediação que diz **o que fazer**.
   */
  it('as seções sem motor devolvem erro tipado com remediação acionável', async () => {
    ({ app } = await buildApp());

    const response = await request(app.getHttpServer())
      .get('/api/v1/ads/ad-1/scores')
      .expect(422);

    expect(response.body.error.code).toBe('SCORE_ENGINE_PENDING');
    expect(response.body.error.remediation).toBeTruthy();
    // Nenhum sprint fechado aparece como promessa ao usuário.
    expect(response.body.error.remediation).not.toMatch(/A2-S\d/);
  });

  it('a série segue a linhagem por padrão (§3.6)', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer())
      .get('/api/v1/ads/ad-1/metrics')
      .expect(200);

    expect(built.ads.series.mock.calls[0][0].followLineage).toBe(true);
  });

  it('permite desligar a linhagem explicitamente', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer())
      .get('/api/v1/ads/ad-1/metrics?followLineage=false')
      .expect(200);

    expect(built.ads.series.mock.calls[0][0].followLineage).toBe(false);
  });

  it('a flag de rollout desliga a superfície inteira', async () => {
    ({ app } = await buildApp({ readEnabled: false }));

    const response = await request(app.getHttpServer())
      .get('/api/v1/ads')
      .expect(409);

    expect(response.body.error.code).toBe('ADS_FIRST_READ_DISABLED');
  });
});

describe('AdContextController', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  /**
   * P1 e §7.4: o contexto é read-only **por ausência de handler**. Este teste
   * não verifica um guard — verifica que os verbos não existem.
   */
  it.each([
    ['post', '/api/v1/campaigns'],
    ['delete', '/api/v1/campaigns/camp-1'],
    ['post', '/api/v1/campaigns/ai/generate-title'],
    ['post', '/api/v1/ad-sets'],
    ['patch', '/api/v1/ad-sets/set-1'],
    // A2-S9 — criativos viraram contexto, e contexto não escreve.
    ['post', '/api/v1/creatives'],
    ['patch', '/api/v1/creatives/creative-1'],
    ['delete', '/api/v1/creatives/creative-1'],
  ])('%s %s não existe', async (method, path) => {
    ({ app } = await buildApp());

    const agent = request(app.getHttpServer()) as unknown as Record<
      string,
      (p: string) => request.Test
    >;
    await agent[method](path).expect(404);
  });

  /**
   * §7.4 / A2-S9 — a rota que estava parqueada "até A2-S4" voltou como
   * **contexto**, não como a superfície do v1.
   *
   * A diferença que este teste fixa: nenhum número de desempenho por criativo.
   * O mesmo criativo em cinco anúncios tem cinco desempenhos, e uma média por
   * criativo descreveria um anúncio que não existe (§3.4).
   */
  it('lista criativos como contexto, sem número de desempenho', async () => {
    ({ app } = await buildApp());

    const response = await request(app.getHttpServer())
      .get('/api/v1/creatives')
      .expect(200);

    const [creative] = response.body.data;
    expect(creative).toMatchObject({ id: 'creative-1', adCount: 3 });
    // Situa, não diagnostica: score e desperdício não aparecem aqui.
    expect(creative).not.toHaveProperty('aiScore');
    expect(creative).not.toHaveProperty('openWaste');
  });

  /**
   * **404, e não 400.** Até A2-S9 este helper usava `VALIDATION`, que §7.0.4
   * mapeia para `400`: um recurso inexistente devolvia "requisição inválida", e
   * as duas coisas pedem telas opostas — corrigir o pedido, ou parar de pedir.
   */
  it('o detalhe de um criativo inexistente é 404, não lista vazia', async () => {
    ({ app } = await buildApp());

    await request(app.getHttpServer())
      .get('/api/v1/creatives/nao-existe')
      .expect(404);
  });

  /**
   * A rota que torna o par `(Creative, Ad)` visível: **cada anúncio com o
   * número dele**, delegando à listagem de `/ads` — que é quem carrega os pisos
   * de confiança de §12.4.
   */
  it('os anúncios de um criativo delegam para a listagem de /ads', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer())
      .get('/api/v1/creatives/creative-7/ads')
      .expect(200);

    expect(built.ads.list.mock.calls[0][0].creativeId).toBe('creative-7');
  });

  it('delega os anúncios da campanha para a listagem de /ads', async () => {
    const built = await buildApp();
    app = built.app;

    await request(app.getHttpServer())
      .get('/api/v1/campaigns/camp-9/ads')
      .expect(200);

    // Uma segunda implementação da listagem divergiria na primeira mudança de
    // filtro — e é a de `/ads` que carrega os pisos de confiança.
    expect(built.ads.list.mock.calls[0][0].campaignId).toBe('camp-9');
  });
});
