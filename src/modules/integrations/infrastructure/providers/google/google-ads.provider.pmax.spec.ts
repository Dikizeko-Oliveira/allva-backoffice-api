import type { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import type { ProviderMetricRow } from 'src/modules/integrations/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GoogleAdsProvider } from './google-ads.provider';

/**
 * **Performance Max de ponta a ponta** (D23).
 *
 * Campanha PMax não tem anúncio: `FROM ad_group_ad` não devolve nada dela, e o
 * gasto inteiro ficava fora da Allva — do score, da detecção e dos totais. A
 * prova aqui é que o grupo de recursos chega como unidade (sem conjunto, com o
 * pacote de recursos no lugar do criativo, com série própria) e que as falhas
 * de cada leitura são declaradas sem derrubar as outras.
 */

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
const ASSET_GROUPS = /FROM asset_group\s+WHERE asset_group\.status/;
/** Os recursos do grupo — sem a consulta à parte da classificação. */
const ASSETS = /^(?![\s\S]*performance_label)[\s\S]*FROM asset_group_asset/;
const LABELS = /performance_label[\s\S]*FROM asset_group_asset/;
const ASSET_GROUP_METRICS = /FROM asset_group\s+WHERE segments\.date/;
const ADS = /FROM ad_group_ad\s+WHERE ad_group_ad\.status/;
/** A consulta de recursos **com** imagem, vídeo e chamada. */
const EXTENDED_ASSETS = /image_asset\.full_size\.url/;
/** A série do grupo **com** CTR e CPC médio. */
const EXTENDED_GROUP_METRICS =
  /metrics\.average_cpc[\s\S]*FROM asset_group\s+WHERE segments\.date/;

const pmaxCampaign = (status = 'ENABLED') => ({
  campaign: {
    id: '6600',
    name: 'PMax — Loja',
    status,
    advertisingChannelType: 'PERFORMANCE_MAX',
    biddingStrategyType: 'MAXIMIZE_CONVERSION_VALUE',
  },
});

const searchCampaign = {
  campaign: {
    id: '5500',
    name: 'Busca',
    status: 'ENABLED',
    advertisingChannelType: 'SEARCH',
  },
};

const assetGroupRow = (campaignStatus = 'ENABLED') => ({
  campaign: { id: '6600', status: campaignStatus },
  assetGroup: {
    id: '8800',
    name: 'Grupo — Verão',
    status: 'ENABLED',
    finalUrls: ['https://loja.example.com/verao'],
    adStrength: 'GOOD',
  },
});

let nextAssetId = 1;
const asset = (
  fieldType: string,
  node: Record<string, unknown>,
  assetGroupId = '8800',
) => ({
  assetGroup: { id: assetGroupId },
  assetGroupAsset: { fieldType, status: 'ENABLED' },
  asset: { id: String(nextAssetId++), ...node },
});

const assetRows = [
  asset('HEADLINE', { textAsset: { text: 'Coleção de verão' } }),
  asset('HEADLINE', { textAsset: { text: 'Frete grátis' } }),
  asset('LONG_HEADLINE', { textAsset: { text: 'Tudo para o verão' } }),
  asset('DESCRIPTION', { textAsset: { text: 'Peças leves e baratas' } }),
  asset('BUSINESS_NAME', { textAsset: { text: 'Loja' } }),
  asset('CALL_TO_ACTION_SELECTION', {
    callToActionAsset: { callToAction: 'SHOP_NOW' },
  }),
  asset('MARKETING_IMAGE', {
    imageAsset: { fullSize: { url: 'https://img.example.com/1.jpg' } },
  }),
  asset('YOUTUBE_VIDEO', { youtubeVideoAsset: { youtubeVideoId: 'abc123' } }),
];

const groupMetricRow = (metrics: Record<string, unknown> = {}) => ({
  campaign: { id: '6600' },
  assetGroup: { id: '8800' },
  metrics: {
    costMicros: '40000000',
    impressions: '2000',
    clicks: '50',
    conversions: 4,
    conversionsValue: 600,
    ...metrics,
  },
  segments: { date: '2026-09-01' },
});

const pmaxRoutes = (overrides: Route[] = []): Route[] => [
  ...overrides,
  { match: CAMPAIGNS, rows: [pmaxCampaign(), searchCampaign] },
  { match: ASSET_GROUPS, rows: [assetGroupRow()] },
  { match: ASSETS, rows: assetRows },
  {
    match: ASSET_GROUP_METRICS,
    rows: [groupMetricRow({ ctr: 0.025, averageCpc: '800000' })],
  },
];

const sync = (levels = ['AD', 'CREATIVE'], adExternalIds?: string[]) =>
  provider().syncAdAccountMetrics(adAccount, integration, window, {
    levels: levels as never,
    adExternalIds,
  });

const unitMetric = (metrics: ProviderMetricRow[], level: string) =>
  metrics.find(
    (metric) =>
      metric.level === level && metric.externalEntityId === 'asset_group:8800',
  );

describe('GoogleAdsProvider — Performance Max', () => {
  it('conta sem Performance Max não paga as leituras de grupo de recursos', async () => {
    const queries = stubGaql([{ match: CAMPAIGNS, rows: [searchCampaign] }]);

    const result = await sync();

    expect(queries.some((query) => /FROM asset_group/.test(query))).toBe(false);
    expect(result.wasComplete).toBe(true);
  });

  it('o grupo de recursos chega como unidade: sem conjunto, com id prefixado', async () => {
    stubGaql(pmaxRoutes());

    const result = await sync();

    expect(result.ads).toContainEqual(
      expect.objectContaining({
        externalAdId: 'asset_group:8800',
        adSetExternalId: null,
        campaignExternalId: '6600',
        creativeExternalId: 'asset_group:8800',
        unitKind: 'ASSET_GROUP',
        name: 'Grupo — Verão',
        status: 'ENABLED',
      }),
    );
    expect(result.wasComplete).toBe(true);
  });

  it('grupo ligado em campanha pausada não entrega', async () => {
    stubGaql(
      pmaxRoutes([{ match: ASSET_GROUPS, rows: [assetGroupRow('PAUSED')] }]),
    );

    const result = await sync();

    expect(
      result.ads?.find((ad) => ad.externalAdId === 'asset_group:8800')?.status,
    ).toBe('PAUSED');
  });

  it('o criativo é o pacote de recursos, com a lista inteira em copyAssets', async () => {
    stubGaql(pmaxRoutes());

    const result = await sync();
    const creative = result.creatives?.find(
      (candidate) => candidate.externalCreativeId === 'asset_group:8800',
    );

    expect(creative).toMatchObject({
      title: 'Coleção de verão',
      body: 'Peças leves e baratas',
      callToAction: 'SHOP_NOW',
      format: 'PERFORMANCE_MAX',
      imageUrl: 'https://img.example.com/1.jpg',
      landingPageUrl: 'https://loja.example.com/verao',
      videoUrl: null,
    });
    expect(creative?.metadata).toMatchObject({
      copyAssets: {
        headlines: [
          { index: 0, text: 'Coleção de verão', pinnedField: null },
          { index: 1, text: 'Frete grátis', pinnedField: null },
        ],
        longHeadlines: [{ index: 0, text: 'Tudo para o verão' }],
      },
      businessName: 'Loja',
      youtubeVideoIds: ['abc123'],
      adStrength: 'GOOD',
    });
  });

  it('a série do grupo entra nos níveis AD e CREATIVE, sem conjunto', async () => {
    stubGaql(pmaxRoutes());

    const result = await sync();

    for (const level of ['AD', 'CREATIVE']) {
      expect(unitMetric(result.metrics, level)).toMatchObject({
        campaignExternalId: '6600',
        adSetExternalId: null,
        adExternalId: 'asset_group:8800',
        spend: 40,
        impressions: 2000,
        clicks: 50,
        conversions: 4,
        revenue: 600,
        ctr: 2.5,
        cpc: 0.8,
        cpa: 10,
      });
    }
  });

  it('CTR e CPC recusados no recurso: relê o mínimo e deriva os dois', async () => {
    const queries = stubGaql(
      pmaxRoutes([
        { match: EXTENDED_GROUP_METRICS, status: 400 },
        {
          match: ASSET_GROUP_METRICS,
          rows: [groupMetricRow()],
        },
      ]),
    );

    const result = await sync();

    expect(
      queries.filter((query) => ASSET_GROUP_METRICS.test(query)),
    ).toHaveLength(2);
    expect(unitMetric(result.metrics, 'AD')).toMatchObject({
      spend: 40,
      ctr: 2.5,
      cpc: 0.8,
    });
    // Recusa de campo contornada não é leitura incompleta.
    expect(result.wasComplete).toBe(true);
  });

  it('estrutura dos grupos falhando: a leitura não autoriza arquivar', async () => {
    stubGaql(pmaxRoutes([{ match: ASSET_GROUPS, status: 500 }]));

    const result = await sync();

    expect(result.wasComplete).toBe(false);
    expect(result.stepFailures).toContainEqual(
      expect.objectContaining({ step: 'ADS', status: 500 }),
    );
    expect(result.ads).toEqual([]);
  });

  it('recursos falhando: o grupo segue, e o pacote não é reescrito com nulos', async () => {
    stubGaql(pmaxRoutes([{ match: ASSETS, status: 500 }]));

    const result = await sync();

    expect(result.ads?.map((ad) => ad.externalAdId)).toEqual([
      'asset_group:8800',
    ]);
    expect(result.creatives).toEqual([]);
    expect(result.stepFailures).toContainEqual(
      expect.objectContaining({ step: 'CREATIVES' }),
    );
  });

  it('recursos com imagem recusada: relê só o texto', async () => {
    const queries = stubGaql(
      pmaxRoutes([{ match: EXTENDED_ASSETS, status: 400 }]),
    );

    const result = await sync();

    expect(queries.filter((query) => ASSETS.test(query))).toHaveLength(2);
    expect(result.creatives?.[0]).toMatchObject({ title: 'Coleção de verão' });
    expect(result.wasComplete).toBe(true);
  });

  it('refresh dirigido só a grupos de recursos não lê anúncios', async () => {
    const queries = stubGaql(pmaxRoutes());

    await sync(['AD'], ['asset_group:8800']);

    expect(queries.some((query) => ADS.test(query))).toBe(false);
    const structure = queries.find((query) => ASSET_GROUPS.test(query));
    expect(structure).toMatch(/asset_group\.id IN \(8800\)/);
  });

  it('refresh dirigido misto manda cada id ao recurso que o lê', async () => {
    const queries = stubGaql(pmaxRoutes());

    await sync(['AD'], ['7788', 'asset_group:8800', 'asset_group:x1']);

    expect(queries.find((query) => ADS.test(query))).toMatch(
      /ad_group_ad\.ad\.id IN \(7788\)/,
    );
    expect(queries.find((query) => ASSET_GROUPS.test(query))).toMatch(
      /asset_group\.id IN \(8800\)\s*$/,
    );
  });

  it('refresh dirigido só a anúncios não lê grupos de recursos', async () => {
    const queries = stubGaql(pmaxRoutes());

    await sync(['AD'], ['7788']);

    expect(queries.some((query) => /FROM asset_group/.test(query))).toBe(false);
  });

  describe('classificação do Google por recurso', () => {
    const label = (
      row: ReturnType<typeof asset>,
      performanceLabel: string,
    ) => ({
      assetGroup: row.assetGroup,
      asset: { id: row.asset.id },
      assetGroupAsset: {
        fieldType: row.assetGroupAsset.fieldType,
        performanceLabel,
      },
    });
    const [firstHeadline, secondHeadline, , description] = assetRows;

    it('cada título e descrição leva a classificação do seu recurso', async () => {
      stubGaql(
        pmaxRoutes([
          {
            match: LABELS,
            rows: [
              label(firstHeadline, 'BEST'),
              label(secondHeadline, 'LOW'),
              label(description, 'LEARNING'),
            ],
          },
        ]),
      );

      const result = await sync();

      expect(result.creatives?.[0].metadata).toMatchObject({
        copyAssets: {
          headlines: [
            { text: 'Coleção de verão', performanceLabel: 'BEST' },
            { text: 'Frete grátis', performanceLabel: 'LOW' },
          ],
          descriptions: [
            { text: 'Peças leves e baratas', performanceLabel: 'LEARNING' },
          ],
          longHeadlines: [
            { text: 'Tudo para o verão', performanceLabel: null },
          ],
        },
      });
    });

    it('classificação indisponível some, sem custar o criativo nem a leitura', async () => {
      stubGaql(pmaxRoutes([{ match: LABELS, status: 400 }]));

      const result = await sync();

      expect(result.creatives?.[0]).toMatchObject({
        title: 'Coleção de verão',
      });
      expect(
        (
          result.creatives?.[0].metadata as {
            copyAssets: { headlines: Array<{ performanceLabel: unknown }> };
          }
        ).copyAssets.headlines[0].performanceLabel,
      ).toBeNull();
      expect(result.wasComplete).toBe(true);
      expect(result.stepFailures).toBeUndefined();
    });

    it('a classificação é do recurso **no grupo**: outro grupo não a herda', async () => {
      stubGaql(
        pmaxRoutes([
          {
            match: LABELS,
            rows: [
              {
                ...label(firstHeadline, 'LOW'),
                assetGroup: { id: '9900' },
              },
            ],
          },
        ]),
      );

      const result = await sync();

      expect(
        (
          result.creatives?.[0].metadata as {
            copyAssets: { headlines: Array<{ performanceLabel: unknown }> };
          }
        ).copyAssets.headlines[0].performanceLabel,
      ).toBeNull();
    });
  });
});
