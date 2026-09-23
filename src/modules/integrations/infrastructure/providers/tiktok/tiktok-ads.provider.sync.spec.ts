import type { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { TikTokAdsProvider } from './tiktok-ads.provider';

const env = {
  get: (key: string) =>
    ({
      TIKTOK_ADS_CLIENT_ID: 'app-id',
      TIKTOK_ADS_CLIENT_SECRET: 'app-secret',
      TIKTOK_ADS_REDIRECT_URI: 'https://app.example.com/cb',
    })[key],
} as unknown as EnvService;

const jwt = { sign: jest.fn(), verify: jest.fn() };
const provider = () => new TikTokAdsProvider(env, jwt as never);

const adAccount = {
  externalAccountId: '7000',
  currency: 'BRL',
} as unknown as AdAccount;
const integration = {
  accessToken: 'token-1',
  refreshToken: null,
} as unknown as Integration;
const window = {
  since: new Date('2026-09-01T00:00:00.000Z'),
  until: new Date('2026-09-02T00:00:00.000Z'),
};

const DAY_MS = 24 * 60 * 60 * 1000;

type Handler = (url: URL, init?: RequestInit) => unknown;

/** Responde por caminho da API; caminho sem handler devolve lista vazia. */
function stubTikTok(handlers: Record<string, Handler>) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];

  jest.spyOn(global, 'fetch').mockImplementation((input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    calls.push({ url, init });

    const path = url.pathname.replace('/open_api/v1.3', '');
    const handler = handlers[path];
    const body = handler ? handler(url, init) : page([]);

    return Promise.resolve(new Response(JSON.stringify(body)));
  });

  return calls;
}

const page = (list: unknown[], current = 1, totalPage = 1) => ({
  code: 0,
  message: 'OK',
  data: { list, page_info: { page: current, total_page: totalPage } },
});

const campaign = {
  campaign_id: 'c1',
  campaign_name: 'Campanha',
  operation_status: 'ENABLE',
  secondary_status: 'CAMPAIGN_STATUS_ENABLE',
  budget_mode: 'BUDGET_MODE_TOTAL',
  budget: 5000,
};

const adGroup = {
  adgroup_id: 'g1',
  adgroup_name: 'Grupo',
  campaign_id: 'c1',
  operation_status: 'ENABLE',
  budget_mode: 'BUDGET_MODE_DAY',
  budget: 50,
};

const ad = (id = 'a1') => ({
  ad_id: id,
  ad_name: `Anúncio ${id}`,
  adgroup_id: 'g1',
  campaign_id: 'c1',
  operation_status: 'ENABLE',
  secondary_status: 'AD_STATUS_DELIVERY_OK',
});

const structure = {
  '/campaign/get/': () => page([campaign]),
  '/adgroup/get/': () => page([adGroup]),
  '/ad/get/': () => page([ad()]),
};

afterEach(() => {
  jest.restoreAllMocks();
  jwt.verify.mockReset();
});

describe('TikTokAdsProvider.syncAdAccountMetrics', () => {
  /**
   * O defeito central: grupos atrás do nível `ADSET`, que o ingest nunca pede.
   * Todo anúncio tem `adgroup_id`, e a conta inteira ia para a quarentena.
   */
  it('lê grupos de anúncios quando o ingest pede só AD e CREATIVE', async () => {
    stubTikTok(structure);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.adSets).toEqual([
      expect.objectContaining({
        externalAdSetId: 'g1',
        campaignExternalId: 'c1',
      }),
    ]);
    expect(result.ads).toHaveLength(1);
    expect(result.wasComplete).toBe(true);
  });

  /**
   * Só a página 1, declarada completa: o que passasse de mil anúncios era
   * arquivado pela guarda de §8.2.
   */
  it('percorre todas as páginas', async () => {
    stubTikTok({
      ...structure,
      '/ad/get/': (url) =>
        url.searchParams.get('page') === '1'
          ? page([ad('a1')], 1, 2)
          : page([ad('a2')], 2, 2),
    });

    const { ads, wasComplete } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(ads?.map((item) => item.externalAdId)).toEqual(['a1', 'a2']);
    expect(wasComplete).toBe(true);
  });

  it('lê o status de entrega (secondary_status), não o campo status da v1.2', async () => {
    stubTikTok(structure);

    const { ads } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(ads?.[0]?.status).toBe('AD_STATUS_DELIVERY_OK');
  });

  it('lê o orçamento pelo budget_mode: total não vira teto diário', async () => {
    stubTikTok(structure);

    const { campaigns, adSets } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(campaigns[0]).toMatchObject({
      dailyBudget: null,
      lifetimeBudget: 5000,
    });
    expect(adSets?.[0]).toMatchObject({
      dailyBudget: 50,
      lifetimeBudget: null,
    });
  });

  it('recusa do relatório vira etapa com falha, sem derrubar a estrutura', async () => {
    stubTikTok({
      ...structure,
      '/report/integrated/get/': () => ({
        code: 40002,
        message: 'Invalid metric',
        data: {},
      }),
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.wasComplete).toBe(false);
    expect(result.stepFailures).toEqual([
      expect.objectContaining({ step: 'INSIGHTS' }),
    ]);
    expect(result.ads).toHaveLength(1);
  });

  it('fixa o dia do relatório em UTC e resolve os pais pelo anúncio', async () => {
    stubTikTok({
      ...structure,
      '/report/integrated/get/': () =>
        page([
          {
            dimensions: { ad_id: 'a1', stat_time_day: '2026-09-01 00:00:00' },
            metrics: { spend: '10.5', impressions: '100', clicks: '3' },
          },
        ]),
    });

    const { metrics } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(metrics[0]).toMatchObject({
      level: 'AD',
      adExternalId: 'a1',
      adSetExternalId: 'g1',
      campaignExternalId: 'c1',
      spend: 10.5,
    });
    expect(metrics[0].date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('não pede o relatório de anúncio duas vezes para AD e CREATIVE', async () => {
    const calls = stubTikTok({
      ...structure,
      '/report/integrated/get/': () =>
        page([
          {
            dimensions: { ad_id: 'a1', stat_time_day: '2026-09-01 00:00:00' },
            metrics: { spend: '1' },
          },
        ]),
    });

    const { metrics } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(
      calls.filter(({ url }) =>
        url.pathname.endsWith('/report/integrated/get/'),
      ),
    ).toHaveLength(1);
    expect(metrics.map((row) => row.level).sort()).toEqual(['AD', 'CREATIVE']);
  });

  /**
   * O defeito: `thumbnailUrl` saía sempre `null` e `videoUrl` guardava o
   * `video_id` cru — que `ffmpeg` sempre recusa por não ser http(s).
   */
  it('resolve thumbnailUrl e videoUrl do anúncio de vídeo via /file/video/ad/info/', async () => {
    const calls = stubTikTok({
      ...structure,
      '/ad/get/': () => page([{ ...ad(), video_id: 'v1' }]),
      '/file/video/ad/info/': () =>
        page([
          {
            video_id: 'v1',
            video_cover_url: 'https://p16.tiktokcdn.com/cover/v1.jpg',
            preview_url: 'https://p16.tiktokcdn.com/preview/v1.mp4',
          },
        ]),
    });

    const { creatives } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(creatives?.[0]).toMatchObject({
      thumbnailUrl: 'https://p16.tiktokcdn.com/cover/v1.jpg',
      videoUrl: 'https://p16.tiktokcdn.com/preview/v1.mp4',
    });
    expect(
      calls.some(({ url }) => url.pathname.endsWith('/file/video/ad/info/')),
    ).toBe(true);
  });

  it('não chama /file/video/ad/info/ quando nenhum anúncio tem vídeo', async () => {
    const calls = stubTikTok(structure);

    await provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD', 'CREATIVE'],
    });

    expect(
      calls.some(({ url }) => url.pathname.endsWith('/file/video/ad/info/')),
    ).toBe(false);
  });

  /**
   * Miniatura e preview são conforto: a falha de `/file/video/ad/info/` não
   * pode marcar `wasComplete = false` e barrar o arquivamento de §8.2 por
   * causa de um pôster que não carregou.
   */
  it('degrada em silêncio quando /file/video/ad/info/ falha, sem afetar wasComplete', async () => {
    stubTikTok({
      ...structure,
      '/ad/get/': () => page([{ ...ad(), video_id: 'v1' }]),
      '/file/video/ad/info/': () => ({
        code: 40100,
        message: 'Video not found',
        data: {},
      }),
    });

    const { creatives, wasComplete, stepFailures } =
      await provider().syncAdAccountMetrics(adAccount, integration, window, {
        levels: ['AD', 'CREATIVE'],
      });

    expect(creatives?.[0]).toMatchObject({
      thumbnailUrl: null,
      videoUrl: null,
    });
    expect(wasComplete).toBe(true);
    expect(stepFailures).toBeUndefined();
  });
});

describe('TikTokAdsProvider — credencial', () => {
  /**
   * O token de anunciante é de longa duração. Gravar 24h e recusar a renovação
   * sem `refresh_token` marcava todo TikTok como `TOKEN_EXPIRED` no dia seguinte.
   */
  it('troca de código sem expires_in não vence em um dia', async () => {
    jwt.verify.mockResolvedValue({
      sub: 'account-1',
      provider: 'TIKTOK',
      purpose: 'connect-integration',
      iat: Math.floor(Date.now() / 1000),
    });
    stubTikTok({
      '/oauth2/access_token/': () => ({
        code: 0,
        message: 'OK',
        data: { access_token: 'long-lived' },
      }),
    });

    const { token } = await provider().exchangeCodeForToken('code', 'state');

    expect(token.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
  });

  it('renovar sem refresh_token revalida o token e estende o prazo', async () => {
    const calls = stubTikTok({
      '/oauth2/advertiser/get/': () => ({
        code: 0,
        message: 'OK',
        data: { list: [] },
      }),
    });

    const refreshed = await provider().refreshAccessToken(integration);

    expect(refreshed.accessToken).toBe('token-1');
    expect(refreshed.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 29 * DAY_MS,
    );
    expect(calls[0].url.pathname).toContain('/oauth2/advertiser/get/');
  });

  it('propaga a recusa do TikTok quando o token não vale mais', async () => {
    stubTikTok({
      '/oauth2/advertiser/get/': () => ({
        code: 40105,
        message: 'Access token is invalid',
        data: {},
      }),
    });

    await expect(provider().refreshAccessToken(integration)).rejects.toThrow(
      'Access token is invalid',
    );
  });

  /** Era um no-op: o token seguia valendo do lado do TikTok depois de desconectar. */
  it('revoga o token na plataforma ao desconectar', async () => {
    const calls = stubTikTok({
      '/oauth2/revoke_token/': () => ({ code: 0, message: 'OK', data: {} }),
    });

    await provider().revokeToken(integration);

    expect(calls[0].url.pathname).toContain('/oauth2/revoke_token/');
    expect(calls[0].init?.method).toBe('POST');
  });
});

/**
 * O objetivo de otimização, **de ponta a ponta no provider**: da resposta de
 * `/campaign/get/` e `/adgroup/get/` ao `optimization` que o ingest grava.
 *
 * No TikTok a métrica `conversion` já é o evento de otimização do grupo; o que o
 * provider precisa acertar é a **classe** e o **evento** — errar a classe reabre
 * o falso positivo de `ZERO_CONVERSIONS` em grupo de alcance.
 */
describe('TikTokAdsProvider — objetivo de otimização', () => {
  const sync = (handlers: Record<string, Handler>) => {
    stubTikTok(handlers);
    return provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD'],
    });
  };

  it('grupo que otimiza formulário grava conversão (lead); a campanha, pelo objetivo', async () => {
    const result = await sync({
      '/campaign/get/': () =>
        page([{ ...campaign, objective_type: 'LEAD_GENERATION' }]),
      '/adgroup/get/': () =>
        page([
          {
            ...adGroup,
            optimization_goal: 'CONVERT',
            optimization_event: 'FORM',
          },
        ]),
      '/ad/get/': () => page([ad()]),
    });

    const lead = {
      optimizationClass: 'CONVERSION',
      conversionEvent: 'LEAD',
      conversionMeasurable: true,
    };
    expect(result.adSets?.[0].optimization).toEqual(lead);
    expect(result.campaigns[0].optimization).toEqual(lead);
  });

  it('a conversão do relatório é a do evento do grupo, sem tradução', async () => {
    const result = await sync({
      ...structure,
      '/adgroup/get/': () =>
        page([
          {
            ...adGroup,
            optimization_goal: 'CONVERT',
            optimization_event: 'ON_WEB_REGISTER',
          },
        ]),
      '/report/integrated/get/': () =>
        page([
          {
            dimensions: { ad_id: 'a1', stat_time_day: '2026-09-01 00:00:00' },
            metrics: {
              spend: '30',
              conversion: '6',
              total_purchase_value: '0',
            },
          },
        ]),
    });

    expect(result.adSets?.[0].optimization?.conversionEvent).toBe(
      'COMPLETE_REGISTRATION',
    );
    expect(result.metrics[0]).toMatchObject({ conversions: 6, cpa: 5 });
  });

  it('grupo de alcance grava alcance', async () => {
    const result = await sync({
      ...structure,
      '/adgroup/get/': () => page([{ ...adGroup, optimization_goal: 'REACH' }]),
    });

    expect(result.adSets?.[0].optimization).toEqual({
      optimizationClass: 'AWARENESS',
      conversionEvent: null,
      conversionMeasurable: false,
    });
  });

  it('grupo sem meta grava UNKNOWN explícito — e a campanha de tráfego decide', async () => {
    const result = await sync({
      '/campaign/get/': () =>
        page([{ ...campaign, objective_type: 'TRAFFIC' }]),
      '/adgroup/get/': () => page([adGroup]),
      '/ad/get/': () => page([ad()]),
    });

    // `UNKNOWN`, e não ausente: a meta foi lida e não disse nada, e
    // `resolveAdOptimization` cai para a campanha.
    expect(result.adSets?.[0].optimization?.optimizationClass).toBe('UNKNOWN');
    expect(result.campaigns[0].optimization?.optimizationClass).toBe('TRAFFIC');
  });
});
