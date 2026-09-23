import type { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GoogleAdsProvider } from './google-ads.provider';

const env = {
  get: (key: string) =>
    ({
      GOOGLE_ADS_CLIENT_ID: 'client-id',
      GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
      GOOGLE_ADS_REDIRECT_URI: 'https://app.example.com/cb',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
      GOOGLE_ADS_API_VERSION: 'v24',
    })[key],
} as unknown as EnvService;

const provider = () =>
  new GoogleAdsProvider(env, { sign: jest.fn(), verify: jest.fn() } as never);

const adAccount = {
  externalAccountId: '4444',
  currency: 'BRL',
} as unknown as AdAccount;
const integration = {
  accessToken: 'token-1',
  refreshToken: 'refresh-1',
} as unknown as Integration;
const window = {
  since: new Date('2026-09-01T00:00:00.000Z'),
  until: new Date('2026-09-02T00:00:00.000Z'),
};

type Route = { match: RegExp; rows?: unknown[]; status?: number };

/** Responde cada GAQL pela forma da consulta — a primeira rota que casar vence. */
function stubGaql(routes: Route[]) {
  const queries: string[] = [];

  jest.spyOn(global, 'fetch').mockImplementation((_input, init) => {
    const { query } = JSON.parse(
      typeof init?.body === 'string' ? init.body : '{}',
    ) as { query: string };
    queries.push(query);

    const route = routes.find((candidate) => candidate.match.test(query));
    if (route?.status && route.status !== 200) {
      return Promise.resolve(
        new Response('INVALID_FIELD', { status: route.status }),
      );
    }

    return Promise.resolve(
      new Response(JSON.stringify([{ results: route?.rows ?? [] }]), {
        status: 200,
      }),
    );
  });

  return queries;
}

afterEach(() => jest.restoreAllMocks());

const CAMPAIGNS = /FROM campaign\s+WHERE campaign\.status/;
const AD_GROUPS = /FROM ad_group\s+WHERE ad_group\.status/;
const ADS = /FROM ad_group_ad\s+WHERE ad_group_ad\.status/;
const EXTENDED_METRICS = /video_trueview_views/;
const METRICS = /FROM ad_group_ad\s+WHERE segments\.date/;
/** A leitura de estrutura **com** o texto de display e do Demand Gen. */
const DISPLAY_FIELDS = /responsive_display_ad\.call_to_action_text/;

const campaignRow = (budget: Record<string, unknown> = {}) => ({
  campaign: {
    id: '5500',
    name: 'Busca',
    status: 'ENABLED',
    advertisingChannelType: 'SEARCH',
  },
  campaignBudget: {
    resourceName: 'customers/4444/campaignBudgets/77',
    amountMicros: '50000000',
    period: 'DAILY',
    explicitlyShared: false,
    ...budget,
  },
});

const adGroupRow = {
  campaign: { id: '5500' },
  adGroup: { id: '9900', name: 'Grupo', status: 'ENABLED' },
};

const adRow = (campaignStatus = 'ENABLED') => ({
  campaign: { id: '5500', status: campaignStatus },
  adGroup: { id: '9900', status: 'ENABLED' },
  adGroupAd: {
    status: 'ENABLED',
    ad: { id: '7788', name: 'Anúncio', type: 'RESPONSIVE_SEARCH_AD' },
  },
});

const displayAdRow = {
  campaign: { id: '5500', status: 'ENABLED' },
  adGroup: { id: '9900', status: 'ENABLED' },
  adGroupAd: {
    status: 'ENABLED',
    ad: {
      id: '7788',
      name: 'Display',
      type: 'RESPONSIVE_DISPLAY_AD',
      responsiveDisplayAd: {
        headlines: [{ text: 'Mais ROAS nas suas campanhas' }],
        descriptions: [{ text: 'Resultados medidos por anúncio' }],
        callToActionText: 'Saiba mais',
      },
    },
  },
};

const metricRow = {
  campaign: { id: '5500' },
  adGroup: { id: '9900' },
  adGroupAd: { ad: { id: '7788' } },
  metrics: {
    costMicros: '12500000',
    impressions: '100',
    clicks: '5',
    videoTrueviewViews: '40',
  },
  segments: { date: '2026-09-01' },
};

const videoAdRow = {
  campaign: { id: '5500', status: 'ENABLED' },
  adGroup: { id: '9900', status: 'ENABLED' },
  adGroupAd: {
    status: 'ENABLED',
    ad: {
      id: '7788',
      name: 'Vídeo',
      type: 'VIDEO_RESPONSIVE_AD',
      videoResponsiveAd: {
        headlines: [{ text: 'Pare de perder horas por semana' }],
        descriptions: [{ text: 'Veja como em dois minutos' }],
        callToActions: [{ text: 'Assistir agora' }],
      },
    },
  },
};

const videoMetricRow = {
  campaign: { id: '5500' },
  adGroup: { id: '9900' },
  adGroupAd: { ad: { id: '7788' } },
  metrics: {
    costMicros: '12500000',
    impressions: '1000',
    clicks: '20',
    videoQuartileP25Rate: '0.4',
    videoQuartileP100Rate: '0.1',
  },
  segments: { date: '2026-09-01' },
};

describe('GoogleAdsProvider.syncAdAccountMetrics', () => {
  /**
   * O defeito central: campanha e grupo estavam atrás dos níveis `CAMPAIGN` e
   * `ADSET`, que o ingest nunca pede. Todo anúncio do Google ia para a
   * quarentena com `CAMPAIGN_NOT_RESOLVED`.
   */
  it('lê campanhas e grupos quando o ingest pede só AD e CREATIVE', async () => {
    const queries = stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: AD_GROUPS, rows: [adGroupRow] },
      { match: ADS, rows: [adRow()] },
      { match: EXTENDED_METRICS, rows: [metricRow] },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.campaigns).toHaveLength(1);
    expect(result.adSets).toEqual([
      expect.objectContaining({
        externalAdSetId: '9900',
        campaignExternalId: '5500',
      }),
    ]);
    expect(result.ads).toEqual([
      expect.objectContaining({
        externalAdId: '7788',
        adSetExternalId: '9900',
        campaignExternalId: '5500',
      }),
    ]);
    expect(result.wasComplete).toBe(true);
    expect(queries.some((query) => CAMPAIGNS.test(query))).toBe(true);
    expect(queries.some((query) => AD_GROUPS.test(query))).toBe(true);
  });

  /**
   * Com `segments.date` a API só devolve o que teve métrica no período, e o
   * Google faz varredura completa em toda leitura: o anúncio parado seria
   * arquivado.
   */
  it('lê estrutura sem segmento de data', async () => {
    const queries = stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: AD_GROUPS, rows: [adGroupRow] },
      { match: ADS, rows: [adRow()] },
    ]);

    await provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD', 'CREATIVE'],
    });

    for (const query of queries.filter(
      (q) => CAMPAIGNS.test(q) || AD_GROUPS.test(q) || ADS.test(q),
    )) {
      expect(query).not.toContain('segments.date');
    }
  });

  it('lê o orçamento pelo period: DAILY é diário, CUSTOM_PERIOD é total', async () => {
    stubGaql([
      {
        match: CAMPAIGNS,
        rows: [
          campaignRow(),
          {
            ...campaignRow({
              period: 'CUSTOM_PERIOD',
              amountMicros: undefined,
              totalAmountMicros: '900000000',
            }),
            campaign: { id: '5501', name: 'Período', status: 'ENABLED' },
          },
        ],
      },
    ]);

    const { campaigns } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(campaigns[0]).toMatchObject({
      dailyBudget: 50,
      lifetimeBudget: null,
    });
    expect(campaigns[1]).toMatchObject({
      dailyBudget: null,
      lifetimeBudget: 900,
    });
  });

  it('grava o status efetivo: ENABLED em campanha pausada é PAUSED', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: ADS, rows: [adRow('PAUSED')] },
    ]);

    const { ads } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(ads?.[0]?.status).toBe('PAUSED');
  });

  it('falha de uma consulta vira etapa com falha, e a leitura deixa de ser completa', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: ADS, status: 500 },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.wasComplete).toBe(false);
    expect(result.stepFailures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ step: 'ADS', status: 500 }),
      ]),
    );
    // O que deu certo continua vindo: uma etapa não derruba as outras.
    expect(result.campaigns).toHaveLength(1);
  });

  it('relê só as métricas-base quando vídeo e engajamento são recusados', async () => {
    stubGaql([
      { match: EXTENDED_METRICS, status: 400 },
      {
        match: METRICS,
        rows: [{ ...metricRow, metrics: { costMicros: '12500000' } }],
      },
      { match: ADS, rows: [adRow()] },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.wasComplete).toBe(true);
    expect(result.metrics).toEqual([
      expect.objectContaining({ level: 'AD', spend: 12.5, videoViews: null }),
    ]);
  });

  it('entrega a série do anúncio com vídeo e com o dia fixado em UTC', async () => {
    stubGaql([
      { match: ADS, rows: [adRow()] },
      { match: EXTENDED_METRICS, rows: [metricRow] },
    ]);

    const { metrics } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(metrics[0]).toMatchObject({
      adExternalId: '7788',
      campaignExternalId: '5500',
      adSetExternalId: '9900',
      spend: 12.5,
      videoViews: 40,
    });
    expect(metrics[0].date.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('refresh dirigido filtra por ids numéricos e não relê grupos', async () => {
    const queries = stubGaql([{ match: ADS, rows: [adRow()] }]);

    await provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD'],
      adExternalIds: ['7788', '1) OR (1=1'],
    });

    expect(queries.some((query) => AD_GROUPS.test(query))).toBe(false);
    const adsQuery = queries.find((query) => ADS.test(query));
    expect(adsQuery).toContain('ad_group_ad.ad.id IN (7788)');
    expect(adsQuery).not.toContain('1=1');
  });

  /**
   * O defeito: `thumbstopRate`/`holdRate` saíam sempre `null` no Google, e sem
   * eles `attention` era estruturalmente incalculável — não por falta de dado,
   * mas porque o provider nunca lia o campo.
   */
  it('calcula thumbstopRate e holdRate a partir do quartil de visualização de vídeo', async () => {
    stubGaql([
      { match: ADS, rows: [videoAdRow] },
      { match: EXTENDED_METRICS, rows: [videoMetricRow] },
    ]);

    const { metrics } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(metrics[0]).toMatchObject({
      thumbstopRate: 0.4,
      holdRate: 0.25, // 0,1 / 0,4
    });
  });

  it('holdRate fica null sem p25 medido, em vez de dividir por zero', async () => {
    stubGaql([
      { match: ADS, rows: [videoAdRow] },
      {
        match: EXTENDED_METRICS,
        rows: [
          {
            ...videoMetricRow,
            metrics: {
              ...videoMetricRow.metrics,
              videoQuartileP25Rate: undefined,
            },
          },
        ],
      },
    ]);

    const { metrics } = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(metrics[0]).toMatchObject({ thumbstopRate: null, holdRate: null });
  });
});

describe('texto do anúncio que não é de busca', () => {
  /**
   * A chamada para ação vinha sempre `null`, e com ela `REPLACE_CTA` não tinha
   * o que mostrar como "o que está no ar hoje".
   */
  it('lê título, descrição e chamada do display responsivo', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: AD_GROUPS, rows: [adGroupRow] },
      { match: ADS, rows: [displayAdRow] },
      { match: EXTENDED_METRICS, rows: [metricRow] },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.creatives).toEqual([
      expect.objectContaining({
        externalCreativeId: '7788',
        format: 'RESPONSIVE_DISPLAY_AD',
        title: 'Mais ROAS nas suas campanhas',
        body: 'Resultados medidos por anúncio',
        callToAction: 'Saiba mais',
      }),
    ]);
  });

  /**
   * O defeito: título, corpo e CTA saíam sempre `null` num anúncio de vídeo, e
   * `MISSING_HEADLINE`/`MISSING_CTA` disparavam sobre um campo que o provider
   * nunca lia — não sobre um campo que a pessoa deixou vazio.
   */
  it('lê título, descrição e chamada do vídeo responsivo', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: AD_GROUPS, rows: [adGroupRow] },
      { match: ADS, rows: [videoAdRow] },
      { match: EXTENDED_METRICS, rows: [videoMetricRow] },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.creatives).toEqual([
      expect.objectContaining({
        externalCreativeId: '7788',
        format: 'VIDEO_RESPONSIVE_AD',
        title: 'Pare de perder horas por semana',
        body: 'Veja como em dois minutos',
        callToAction: 'Assistir agora',
      }),
    ]);
  });

  /**
   * Um campo que a versão da API não aceita derruba a consulta inteira. Perder
   * o texto do display custa a aplicabilidade do CTA; perder a estrutura
   * mandaria a conta inteira para a quarentena.
   */
  it('relê a estrutura sem o texto de display quando a API recusa os campos', async () => {
    const queries = stubGaql([
      { match: DISPLAY_FIELDS, status: 400 },
      { match: CAMPAIGNS, rows: [campaignRow()] },
      { match: AD_GROUPS, rows: [adGroupRow] },
      { match: ADS, rows: [adRow()] },
      { match: EXTENDED_METRICS, rows: [metricRow] },
    ]);

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.ads).toHaveLength(1);
    // A releitura não é falha de etapa: a estrutura veio inteira, sem o texto.
    expect(result.wasComplete).toBe(true);
    expect(queries.filter((query) => ADS.test(query))).toHaveLength(2);
  });
});

describe('GoogleAdsProvider.listAdAccounts', () => {
  /** Conta gerente não veicula anúncio: vinculá-la produzia ingest que falha sempre. */
  it('não oferece conta gerente (MCC) para vincular', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = input instanceof Request ? input.url : input.toString();

      if (url.endsWith('customers:listAccessibleCustomers')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ resourceNames: ['customers/1', 'customers/2'] }),
          ),
        );
      }

      const manager = url.includes('/customers/1/');
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              results: [
                {
                  customer: {
                    descriptiveName: manager ? 'MCC' : 'Loja',
                    currencyCode: 'BRL',
                    timeZone: 'America/Sao_Paulo',
                    manager,
                  },
                },
              ],
            },
          ]),
        ),
      );
    });

    const accounts = await provider().listAdAccounts(integration);

    expect(accounts).toEqual([
      expect.objectContaining({ externalAccountId: '2', currency: 'BRL' }),
    ]);
  });
});

/**
 * O objetivo de otimização, **de ponta a ponta no provider**: da resposta GAQL
 * ao `optimization` que o ingest grava em `campaigns` e `ad_sets`.
 *
 * No Google a contagem de conversões já segue as metas da campanha; o que o
 * provider precisa acertar é a **classe** (lance + canal) e o **evento** (metas
 * lançáveis). Errar a classe reabre o falso positivo de `ZERO_CONVERSIONS` em
 * campanha de alcance.
 */
describe('GoogleAdsProvider — objetivo de otimização', () => {
  const GOALS = /FROM campaign_conversion_goal/;

  const biddingCampaign = (
    biddingStrategyType: string,
    advertisingChannelType = 'SEARCH',
  ) => ({
    campaign: {
      id: '5500',
      name: 'Campanha',
      status: 'ENABLED',
      advertisingChannelType,
      biddingStrategyType,
    },
  });

  const goal = (category: string) => ({
    campaign: { id: '5500' },
    campaignConversionGoal: { category, biddable: true },
  });

  const sync = () =>
    provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD', 'CREATIVE'],
    });

  it('pede a estratégia de lance e só as metas lançáveis', async () => {
    const queries = stubGaql([]);

    await sync();

    expect(queries.find((query) => CAMPAIGNS.test(query))).toContain(
      'campaign.bidding_strategy_type',
    );
    expect(queries.find((query) => GOALS.test(query))).toMatch(
      /campaign_conversion_goal\.biddable = TRUE/,
    );
  });

  it('lance de conversão com meta de lead: campanha e grupo gravam conversão (lead)', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [biddingCampaign('TARGET_CPA')] },
      {
        match: GOALS,
        rows: [goal('SUBMIT_LEAD_FORM'), goal('QUALIFIED_LEAD')],
      },
      { match: AD_GROUPS, rows: [adGroupRow] },
    ]);

    const result = await sync();

    const expected = {
      optimizationClass: 'CONVERSION',
      conversionEvent: 'LEAD',
      conversionMeasurable: true,
    };
    expect(result.campaigns[0].optimization).toEqual(expected);
    // No Google a otimização é da campanha: o grupo herda, para o anúncio
    // resolver o mesmo objetivo pelos dois caminhos.
    expect(result.adSets?.[0].optimization).toEqual(expected);
  });

  it('metas de categorias diferentes viram "várias metas"', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [biddingCampaign('MAXIMIZE_CONVERSIONS')] },
      { match: GOALS, rows: [goal('PURCHASE'), goal('SIGNUP')] },
    ]);

    const result = await sync();

    expect(result.campaigns[0].optimization?.conversionEvent).toBe('MULTIPLE');
  });

  it('vídeo com lance por CPM é alcance, e o grupo herda', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [biddingCampaign('TARGET_CPM', 'VIDEO')] },
      { match: GOALS, rows: [goal('PURCHASE')] },
      { match: AD_GROUPS, rows: [adGroupRow] },
    ]);

    const result = await sync();

    expect(result.campaigns[0].optimization?.optimizationClass).toBe(
      'AWARENESS',
    );
    expect(result.adSets?.[0].optimization?.optimizationClass).toBe(
      'AWARENESS',
    );
  });

  it('leitura das metas falhando: o sync segue completo e lance manual não cobra conversão', async () => {
    stubGaql([
      { match: CAMPAIGNS, rows: [biddingCampaign('MANUAL_CPC')] },
      { match: GOALS, status: 500 },
      { match: AD_GROUPS, rows: [adGroupRow] },
    ]);

    const result = await sync();

    // Acessória: não entra em `stepFailures`, porque não diz nada sobre o que
    // arquivar — e uma falha aqui não pode travar o arquivamento da conta.
    expect(result.wasComplete).toBe(true);
    expect(result.campaigns[0].optimization?.optimizationClass).toBe('TRAFFIC');
  });
});
