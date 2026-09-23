import type { AdAccount } from 'src/modules/integrations/domain/entities/ad-account.entity';
import type { Integration } from 'src/modules/integrations/domain/entities/integration.entity';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { MetaAdsProvider } from './meta-ads.provider';

/**
 * O provider da Meta **de ponta a ponta**, com a Graph API simulada por caminho.
 *
 * `meta-conversion-events.spec.ts` prova a tradução em isolamento; aqui a prova
 * é que o provider a aplica: lê o `promoted_object` do conjunto, conta a
 * conversão de cada linha pelo evento **daquele** conjunto e entrega o
 * `optimization` que o ingest grava. É o caminho que, quebrado, reabre o falso
 * positivo — anúncio de lead contado por compra e recomendado para pausa.
 */

const env = {
  get: (key: string) =>
    ({
      META_APP_ID: 'app-id',
      META_APP_SECRET: 'app-secret',
      META_CALLBACK_URL: 'https://app.example.com/cb',
      META_API_VERSION: 'v23.0',
    })[key],
} as unknown as EnvService;

const provider = () =>
  new MetaAdsProvider(env, { sign: jest.fn(), verify: jest.fn() } as never);

const adAccount = {
  externalAccountId: 'act_1',
  currency: 'BRL',
} as unknown as AdAccount;
const integration = { accessToken: 'token-1' } as unknown as Integration;
const window = {
  since: new Date('2026-09-01T00:00:00.000Z'),
  until: new Date('2026-09-02T00:00:00.000Z'),
};

type Handler = (url: URL) => unknown[];

/**
 * Responde pelo último segmento do caminho (`insights`, `adsets`...), com o
 * envelope de página da Graph. Caminho sem handler devolve lista vazia.
 */
function stubGraph(handlers: Record<string, Handler>) {
  const calls: URL[] = [];

  jest.spyOn(global, 'fetch').mockImplementation((input) => {
    const url = new URL(
      input instanceof Request ? input.url : input.toString(),
    );
    calls.push(url);

    const edge = url.pathname.split('/').pop() ?? '';
    const data = handlers[edge]?.(url) ?? [];

    return Promise.resolve(
      new Response(JSON.stringify({ data, paging: {} }), { status: 200 }),
    );
  });

  return calls;
}

afterEach(() => jest.restoreAllMocks());

const actions = (entries: Record<string, number>) =>
  Object.entries(entries).map(([action_type, value]) => ({
    action_type,
    value: String(value),
  }));

const campaignNode = (objective = 'OUTCOME_LEADS') => ({
  id: 'c1',
  name: 'Campanha',
  status: 'ACTIVE',
  objective,
});

const adSetNode = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'Conjunto',
  status: 'ACTIVE',
  campaign_id: 'c1',
  optimization_goal: 'OFFSITE_CONVERSIONS',
  promoted_object: { pixel_id: 'px', custom_event_type: 'LEAD' },
  ...overrides,
});

const adNode = {
  id: 'a1',
  name: 'Anúncio',
  status: 'ACTIVE',
  effective_status: 'ACTIVE',
  adset_id: 's1',
  campaign_id: 'c1',
};

/** Uma linha de insights no nível do anúncio, com lead e compra ao mesmo tempo. */
const insightRow = {
  date_start: '2026-09-01',
  date_stop: '2026-09-01',
  campaign_id: 'c1',
  adset_id: 's1',
  ad_id: 'a1',
  spend: '70',
  impressions: '1000',
  clicks: '40',
  actions: actions({ lead: 7, purchase: 1, landing_page_view: 30 }),
  action_values: actions({ purchase: 150 }),
  cost_per_action_type: actions({ lead: 10, purchase: 70 }),
};

/** Insights só no nível `ad` — os outros níveis não são o que o ingest grava. */
const adLevelInsights: Handler = (url) =>
  url.searchParams.get('level') === 'ad' ? [insightRow] : [];

const adMetric = (metrics: Array<{ level: string }>) =>
  metrics.find((metric) => metric.level === 'AD');

describe('MetaAdsProvider — objetivo de otimização de ponta a ponta', () => {
  it('pede o promoted_object do conjunto', async () => {
    const calls = stubGraph({});

    await provider().syncAdAccountMetrics(adAccount, integration, window, {
      levels: ['AD', 'CREATIVE'],
    });

    const adSetsCall = calls.find((url) => url.pathname.endsWith('/adsets'));
    expect(adSetsCall?.searchParams.get('fields')).toContain('promoted_object');
  });

  it('conjunto de lead: grava conversão (lead) e a linha conta lead, não compra', async () => {
    stubGraph({
      campaigns: () => [campaignNode('OUTCOME_LEADS')],
      adsets: () => [adSetNode()],
      ads: () => [adNode],
      insights: adLevelInsights,
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD', 'CREATIVE'] },
    );

    expect(result.adSets?.[0].optimization).toEqual({
      optimizationClass: 'CONVERSION',
      conversionEvent: 'LEAD',
      conversionMeasurable: true,
    });
    expect(result.campaigns[0].optimization?.conversionEvent).toBe('LEAD');

    // Sete leads, custo por lead 10 — e a compra incidental não entra, nem
    // como contagem nem como receita somada a um "ROAS de lead".
    expect(adMetric(result.metrics)).toMatchObject({
      conversions: 7,
      cpa: 10,
      revenue: 0,
    });
  });

  it('o conjunto não vaza para o resultado com a lista de tipos interna', async () => {
    stubGraph({ adsets: () => [adSetNode()] });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.adSets?.[0]).not.toHaveProperty('conversionSpec');
  });

  it('conjunto de tráfego grava tráfego, e a linha registra a compra incidental', async () => {
    stubGraph({
      campaigns: () => [campaignNode('OUTCOME_TRAFFIC')],
      adsets: () => [
        adSetNode({
          optimization_goal: 'LANDING_PAGE_VIEWS',
          promoted_object: undefined,
        }),
      ],
      insights: adLevelInsights,
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.adSets?.[0].optimization?.optimizationClass).toBe('TRAFFIC');
    // A compra acontece e é receita real; quem impede julgá-la como conversão
    // é o portão de objetivo, que lê a classe gravada.
    expect(adMetric(result.metrics)).toMatchObject({
      conversions: 1,
      revenue: 150,
    });
  });

  it('conjunto sem meta grava UNKNOWN, e a linha conta pelo objetivo da campanha', async () => {
    stubGraph({
      campaigns: () => [campaignNode('OUTCOME_SALES')],
      adsets: () => [
        adSetNode({ optimization_goal: undefined, promoted_object: undefined }),
      ],
      insights: adLevelInsights,
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'] },
    );

    expect(result.adSets?.[0].optimization?.optimizationClass).toBe('UNKNOWN');
    expect(result.campaigns[0].optimization?.conversionEvent).toBe('PURCHASE');
    expect(adMetric(result.metrics)).toMatchObject({ conversions: 1 });
  });

  it('refresh dirigido busca só o evento dos conjuntos das linhas, sem devolvê-los como estrutura', async () => {
    const calls = stubGraph({
      campaigns: () => [campaignNode('OUTCOME_LEADS')],
      ads: () => [adNode],
      adsets: (url) =>
        url.searchParams.get('fields') ===
        'id,optimization_goal,promoted_object'
          ? [adSetNode()]
          : [],
      insights: adLevelInsights,
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'], adExternalIds: ['a1'] },
    );

    const specCall = calls.find(
      (url) =>
        url.pathname.endsWith('/adsets') &&
        url.searchParams.get('fields') ===
          'id,optimization_goal,promoted_object',
    );
    expect(specCall).toBeDefined();
    expect(JSON.parse(specCall!.searchParams.get('filtering') ?? '[]')).toEqual(
      [{ field: 'adset.id', operator: 'IN', value: ['s1'] }],
    );

    // A hierarquia não é relida no refresh dirigido: o conjunto já está no banco.
    expect(result.adSets).toEqual([]);
    // Mas a contagem usa o evento dele — lead, e não a compra.
    expect(adMetric(result.metrics)).toMatchObject({ conversions: 7 });
  });

  it('falha na leitura do evento do refresh não marca a leitura como incompleta', async () => {
    jest.spyOn(global, 'fetch').mockImplementation((input) => {
      const url = new URL(
        input instanceof Request ? input.url : input.toString(),
      );
      const isSpecRead =
        url.pathname.endsWith('/adsets') &&
        url.searchParams.get('fields') ===
          'id,optimization_goal,promoted_object';

      if (isSpecRead) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: { message: 'boom' } }), {
            status: 500,
          }),
        );
      }

      const data =
        url.pathname.endsWith('/insights') &&
        url.searchParams.get('level') === 'ad'
          ? [insightRow]
          : url.pathname.endsWith('/campaigns')
            ? [campaignNode('OUTCOME_LEADS')]
            : [];

      return Promise.resolve(new Response(JSON.stringify({ data })));
    });

    const result = await provider().syncAdAccountMetrics(
      adAccount,
      integration,
      window,
      { levels: ['AD'], adExternalIds: ['a1'] },
    );

    expect(result.wasComplete).toBe(true);
    // Sem o evento do conjunto, a linha cai para o objetivo da campanha (lead).
    expect(adMetric(result.metrics)).toMatchObject({ conversions: 7 });
  });
});
