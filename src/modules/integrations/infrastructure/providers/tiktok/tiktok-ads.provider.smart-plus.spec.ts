import type { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import type {
  ProviderMetricRow,
  ProviderSyncResult,
} from 'src/modules/integrations/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { TikTokAdsProvider } from './tiktok-ads.provider';

/**
 * **Smart+ de ponta a ponta no provider** (D24), com a API simulada por caminho
 * a partir dos formatos do SDK oficial — sem conta real para conferir.
 *
 * A prova é que, com o interruptor ligado, o gasto de cada anúncio entra **uma
 * vez** nas três respostas possíveis (as rotas padrão cobrem, não cobrem, ou
 * cobrem sob outro id), e que desligado nada muda.
 */

const envWith = (smartPlus: boolean) =>
  ({
    get: (key: string) =>
      ({
        TIKTOK_ADS_CLIENT_ID: 'app-id',
        TIKTOK_ADS_CLIENT_SECRET: 'app-secret',
        TIKTOK_ADS_REDIRECT_URI: 'https://app.example.com/cb',
        TIKTOK_SMART_PLUS_ENABLED: smartPlus,
      })[key],
  }) as unknown as EnvService;

const provider = (smartPlus = true) =>
  new TikTokAdsProvider(envWith(smartPlus), {
    sign: jest.fn(),
    verify: jest.fn(),
  } as never);

const adAccount = {
  externalAccountId: '7000',
  currency: 'BRL',
} as unknown as AdAccount;
const integration = { accessToken: 'token-1' } as unknown as Integration;
const window = {
  since: new Date('2026-09-01T00:00:00.000Z'),
  until: new Date('2026-09-02T00:00:00.000Z'),
};

type Handler = (url: URL) => unknown;

function stubTikTok(handlers: Record<string, Handler>) {
  const calls: URL[] = [];

  jest.spyOn(global, 'fetch').mockImplementation((input) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    calls.push(url);

    const path = url.pathname.replace('/open_api/v1.3', '');
    const body = handlers[path] ? handlers[path](url) : page([]);

    return Promise.resolve(new Response(JSON.stringify(body)));
  });

  return calls;
}

afterEach(() => jest.restoreAllMocks());

const page = (list: unknown[]) => ({
  code: 0,
  message: 'OK',
  data: { list, page_info: { page: 1, total_page: 1 } },
});
const refused = (message = 'Invalid metric') => ({ code: 40002, message });

const smartCampaign = {
  campaign_id: 'sc1',
  campaign_name: 'Smart+ Vendas',
  operation_status: 'ENABLE',
  secondary_status: 'CAMPAIGN_STATUS_ENABLE',
  objective_type: 'WEB_CONVERSIONS',
  budget_mode: 'BUDGET_MODE_DAY',
  budget: 300,
};

const smartAdGroup = {
  adgroup_id: 'sg1',
  adgroup_name: 'Smart+ grupo',
  campaign_id: 'sc1',
  operation_status: 'ENABLE',
  optimization_goal: 'CONVERT',
  optimization_event: 'SHOPPING',
};

const smartAd = (id = 's1') => ({
  smart_plus_ad_id: id,
  ad_name: `Smart+ ${id}`,
  adgroup_id: 'sg1',
  campaign_id: 'sc1',
  operation_status: 'ENABLE',
  secondary_status: 'AD_STATUS_DELIVERY_OK',
  creative_list: [
    { ad_material_id: 'm1', creative_info: { video_info: { video_id: 'v1' } } },
    { ad_material_id: 'm2', creative_info: { video_info: { video_id: 'v2' } } },
  ],
  ad_text_list: [{ ad_text: 'Leve dois' }, { ad_text: 'Frete grátis' }],
  call_to_action_list: [{ call_to_action: 'SHOP_NOW' }],
  landing_page_url_list: [{ landing_page_url: 'https://loja.example.com' }],
});

/** O anúncio como a rota padrão o devolveria, se devolvesse. */
const standardAd = (id: string) => ({
  ad_id: id,
  ad_name: `Padrão ${id}`,
  adgroup_id: 'sg1',
  campaign_id: 'sc1',
  operation_status: 'ENABLE',
  secondary_status: 'AD_STATUS_DELIVERY_OK',
});

const dailyRow = (spend: number, roas?: number) => ({
  dimensions: { stat_time_day: '2026-09-01 00:00:00' },
  metrics: {
    spend: String(spend),
    impressions: '5000',
    clicks: '100',
    conversion: '5',
    ...(roas ? { complete_payment_roas: String(roas) } : {}),
  },
});

const adReportRow = (adId: string, spend: number) => ({
  dimensions: { ad_id: adId, stat_time_day: '2026-09-01 00:00:00' },
  metrics: { spend: String(spend), impressions: '5000', clicks: '100' },
});

/** Só o Smart+ pela rota própria: as padrão não o enxergam. */
const smartPlusOnly: Record<string, Handler> = {
  '/smart_plus/campaign/get/': () => page([smartCampaign]),
  '/smart_plus/adgroup/get/': () => page([smartAdGroup]),
  '/smart_plus/ad/get/': () => page([smartAd()]),
  '/smart_plus/material_report/breakdown/': () => page([dailyRow(120, 3)]),
};

const sync = (
  instance: TikTokAdsProvider,
  adExternalIds?: string[],
): Promise<ProviderSyncResult> =>
  instance.syncAdAccountMetrics(adAccount, integration, window, {
    levels: ['AD', 'CREATIVE'],
    adExternalIds,
  });

const adSpend = (metrics: ProviderMetricRow[], adId: string) =>
  metrics
    .filter((m) => m.level === 'AD' && m.externalEntityId === adId)
    .reduce((sum, m) => sum + m.spend, 0);

const reportCalls = (calls: URL[]) =>
  calls.filter((url) => url.pathname.endsWith('/material_report/breakdown/'));

describe('TikTokAdsProvider — Smart+ (D24)', () => {
  it('desligado: nenhuma chamada às rotas Smart+', async () => {
    const calls = stubTikTok(smartPlusOnly);

    const result = await sync(provider(false));

    expect(calls.some((url) => url.pathname.includes('/smart_plus/'))).toBe(
      false,
    );
    expect(result.ads).toEqual([]);
  });

  it('rota padrão não enxerga o Smart+: campanha, grupo e anúncio entram, com a série própria', async () => {
    const calls = stubTikTok(smartPlusOnly);

    const result = await sync(provider());

    expect(result.campaigns.map((c) => c.externalCampaignId)).toEqual(['sc1']);
    expect(result.campaigns[0].optimization?.optimizationClass).toBe(
      'CONVERSION',
    );
    expect(result.adSets?.map((s) => s.externalAdSetId)).toEqual(['sg1']);
    expect(result.ads).toEqual([
      expect.objectContaining({
        externalAdId: 's1',
        adSetExternalId: 'sg1',
        unitKind: 'ASSET_GROUP',
      }),
    ]);
    expect(result.creatives?.[0]).toMatchObject({
      externalCreativeId: 's1',
      format: 'SMART_PLUS',
      body: 'Leve dois',
    });

    // Série do relatório próprio, filtrada pelo anúncio, com receita derivada.
    const [report] = reportCalls(calls);
    expect(JSON.parse(report.searchParams.get('filtering') ?? '{}')).toEqual({
      smart_plus_ad_ids: ['s1'],
    });
    expect(JSON.parse(report.searchParams.get('dimensions') ?? '[]')).toEqual([
      'stat_time_day',
    ]);
    const row = result.metrics.find(
      (m) => m.level === 'AD' && m.externalEntityId === 's1',
    );
    expect(row).toMatchObject({
      campaignExternalId: 'sc1',
      adSetExternalId: 'sg1',
      spend: 120,
      revenue: 360,
      conversions: 5,
      ctr: 2,
    });
    expect(
      result.metrics.some(
        (m) => m.level === 'CREATIVE' && m.externalEntityId === 's1',
      ),
    ).toBe(true);
    expect(result.wasComplete).toBe(true);
  });

  it('rota padrão já cobre, com o mesmo id: uma unidade só, série do relatório padrão', async () => {
    const calls = stubTikTok({
      ...smartPlusOnly,
      '/campaign/get/': () => page([smartCampaign]),
      '/adgroup/get/': () => page([smartAdGroup]),
      '/ad/get/': () => page([standardAd('s1')]),
      '/report/integrated/get/': () => page([adReportRow('s1', 120)]),
    });

    const result = await sync(provider());

    expect(result.campaigns).toHaveLength(1);
    expect(result.ads).toEqual([
      expect.objectContaining({ externalAdId: 's1', unitKind: 'ASSET_GROUP' }),
    ]);
    expect(result.creatives?.map((c) => c.format)).toEqual(['SMART_PLUS']);
    expect(reportCalls(calls)).toHaveLength(0);
    expect(adSpend(result.metrics, 's1')).toBe(120);
  });

  it('rota padrão cobre sob outro id: nada é somado', async () => {
    const calls = stubTikTok({
      ...smartPlusOnly,
      '/campaign/get/': () => page([smartCampaign]),
      '/adgroup/get/': () => page([smartAdGroup]),
      '/ad/get/': () => page([standardAd('a-outro')]),
      '/report/integrated/get/': () => page([adReportRow('a-outro', 120)]),
    });

    const result = await sync(provider());

    expect(result.ads?.map((ad) => ad.externalAdId)).toEqual(['a-outro']);
    expect(reportCalls(calls)).toHaveLength(0);
    const total = result.metrics
      .filter((m) => m.level === 'AD')
      .reduce((sum, m) => sum + m.spend, 0);
    expect(total).toBe(120);
  });

  it('relatório padrão já trouxe a série do anúncio: não relê pelo próprio', async () => {
    const calls = stubTikTok({
      ...smartPlusOnly,
      '/report/integrated/get/': () => page([adReportRow('s1', 120)]),
    });

    const result = await sync(provider());

    expect(reportCalls(calls)).toHaveLength(0);
    expect(adSpend(result.metrics, 's1')).toBe(120);
  });

  it('receita recusada no relatório próprio: relê o mínimo, sem marcar a leitura incompleta', async () => {
    const calls = stubTikTok({
      ...smartPlusOnly,
      '/smart_plus/material_report/breakdown/': (url) =>
        (url.searchParams.get('metrics') ?? '').includes(
          'complete_payment_roas',
        )
          ? refused()
          : page([dailyRow(120)]),
    });

    const result = await sync(provider());

    expect(reportCalls(calls)).toHaveLength(2);
    expect(
      result.metrics.find(
        (m) => m.level === 'AD' && m.externalEntityId === 's1',
      ),
    ).toMatchObject({ spend: 120, revenue: 0 });
    expect(result.wasComplete).toBe(true);
  });

  it('rota Smart+ recusando: a leitura não autoriza arquivar', async () => {
    stubTikTok({
      ...smartPlusOnly,
      '/smart_plus/campaign/get/': () => refused('No permission'),
    });

    const result = await sync(provider());

    expect(result.wasComplete).toBe(false);
    expect(result.stepFailures).toContainEqual(
      expect.objectContaining({ step: 'CAMPAIGNS' }),
    );
  });

  it('refresh dirigido: pede os anúncios Smart+ pelo id e lê a série deles', async () => {
    const calls = stubTikTok(smartPlusOnly);

    const result = await sync(provider(), ['s1']);

    const adRead = calls.find((url) =>
      url.pathname.endsWith('/smart_plus/ad/get/'),
    );
    expect(JSON.parse(adRead?.searchParams.get('filtering') ?? '{}')).toEqual({
      smart_plus_ad_ids: ['s1'],
    });
    expect(adRead?.searchParams.get('page_size')).toBe('100');
    expect(
      calls.some((url) => url.pathname.endsWith('/smart_plus/campaign/get/')),
    ).toBe(false);
    expect(result.ads?.[0]).toMatchObject({
      externalAdId: 's1',
      unitKind: 'ASSET_GROUP',
    });
    expect(adSpend(result.metrics, 's1')).toBe(120);
  });
});
