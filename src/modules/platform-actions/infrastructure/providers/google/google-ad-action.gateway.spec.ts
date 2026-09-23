import { classifyPlatformError } from 'src/modules/platform-clients/domain/platform-error';
import {
  PlatformHttpClient,
  PlatformRequestError,
} from 'src/modules/platform-clients/infrastructure/platform-http.client';
import type {
  AdActionCommand,
  ExecutionContext,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GoogleAdActionGateway } from './google-ad-action.gateway';

const env = {
  get: (key: string) =>
    ({
      GOOGLE_ADS_API_VERSION: 'v24',
      GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
      GOOGLE_ADS_LOGIN_CUSTOMER_ID: '111',
    })[key],
} as unknown as EnvService;

function gatewayWith(request: jest.Mock) {
  return new GoogleAdActionGateway(
    { request } as unknown as PlatformHttpClient,
    env,
  );
}

const ctx: ExecutionContext = {
  idempotencyKey: 'key-1',
  integrationId: 'int-1',
  externalAccountId: '4444',
  accessToken: 'token-1',
  correlationId: null,
  attempt: 1,
};

/**
 * O alvo como o domínio o guarda: **o id numérico** que o ingest gravou. A
 * versão anterior destes testes usava resource names prontos — exatamente o que
 * o banco nunca teve —, e por isso passavam enquanto toda escrita real no Google
 * era recusada.
 */
const pauseAd: AdActionCommand = {
  type: 'PAUSE_AD',
  level: 'AD',
  target: { type: 'AD', internalId: 'ad-uuid', externalId: '7788' },
  parameters: { schemaVersion: 1, adId: 'ad-uuid' },
  accountCurrency: 'BRL',
};

const budget: AdActionCommand = {
  type: 'ADJUST_CAMPAIGN_BUDGET',
  level: 'CAMPAIGN',
  target: { type: 'CAMPAIGN', internalId: 'camp-uuid', externalId: '5500' },
  parameters: {
    schemaVersion: 1,
    campaignId: 'camp-uuid',
    dailyBudget: 150.5,
    previousDailyBudget: 99,
    currency: 'BRL',
  },
  accountCurrency: 'BRL',
};

const search = (results: unknown[]) => ({ data: { results } });
const mutated = () => ({ data: { results: [] } });

const AD_RESOURCE = 'customers/4444/adGroupAds/1~7788';
const adFound = () => search([{ adGroupAd: { resourceName: AD_RESOURCE } }]);
const dailyBudget = (overrides: Record<string, unknown> = {}) =>
  search([
    {
      campaignBudget: {
        resourceName: 'customers/4444/campaignBudgets/77',
        period: 'DAILY',
        explicitlyShared: false,
        ...overrides,
      },
    },
  ]);

const callOf = (request: jest.Mock, call = 0) =>
  request.mock.calls[call][0] as {
    url: string;
    headers?: Record<string, string>;
    body?: {
      query?: string;
      operations?: Array<Record<string, unknown>>;
    };
  };

describe('capabilities do Google (§13.1)', () => {
  const gateway = gatewayWith(jest.fn());

  it('suporta o mesmo subconjunto de estado da Meta, nos três níveis', () => {
    const supported = gateway
      .capabilities()
      .filter((c) => c.supported)
      .map((c) => c.type)
      .sort();

    expect(supported).toEqual(
      [
        'PAUSE_AD',
        'ENABLE_AD',
        'PAUSE_AD_SET',
        'ENABLE_AD_SET',
        'PAUSE_CAMPAIGN',
        'ENABLE_CAMPAIGN',
        'ARCHIVE_AD',
        'ADJUST_CAMPAIGN_BUDGET',
        'REPLACE_COPY',
        'REPLACE_CTA',
        'DUPLICATE_AD',
      ].sort(),
    );
  });

  /**
   * O que P6 ganha com o recorte por formato: as duas ações de texto existem no
   * Google, em anúncios diferentes. Sem isto, as duas apareciam em todo anúncio
   * e metade delas só podia falhar na execução.
   */
  it('recorta as ações de texto por formato de anúncio', () => {
    const formatsOf = (type: string) =>
      gateway.capabilities().find((c) => c.type === type)?.formats?.formats;

    expect(formatsOf('REPLACE_COPY')).toEqual(['RESPONSIVE_SEARCH_AD']);
    expect(formatsOf('DUPLICATE_AD')).toEqual(['RESPONSIVE_SEARCH_AD']);
    expect(formatsOf('REPLACE_CTA')).toEqual([
      'RESPONSIVE_DISPLAY_AD',
      'DEMAND_GEN_MULTI_ASSET_AD',
      'DEMAND_GEN_CAROUSEL_AD',
    ]);
  });

  it('troca texto editando o asset em lugar, sem recriar', () => {
    expect(
      gateway.capabilities().find((c) => c.type === 'REPLACE_COPY'),
    ).toMatchObject({
      supported: true,
      requiresRecreate: false,
      createsEntity: false,
      constraints: { target: 'ASSET' },
    });
  });

  it('cobre os treze tipos, sem buraco', () => {
    expect(gateway.capabilities()).toHaveLength(13);
  });

  /**
   * A diferença que P6 existe para tornar visível: no Google, orçamento de grupo
   * de anúncios **não existe** — não é "ainda não implementado".
   */
  it('declara que grupo de anúncios não tem orçamento próprio', () => {
    const capability = gateway
      .capabilities()
      .find((c) => c.type === 'ADJUST_AD_SET_BUDGET');

    expect(capability?.supported).toBe(false);
    expect(capability?.unsupportedReason).toContain('vive na campanha');
  });

  it('declara arquivamento irreversível', () => {
    expect(
      gateway.capabilities().find((c) => c.type === 'ARCHIVE_AD'),
    ).toMatchObject({ supported: true, reversible: false });
  });

  it('declara motivo para toda ação não suportada, sem dizer que é igual nas três', () => {
    for (const capability of gateway
      .capabilities()
      .filter((c) => !c.supported)) {
      expect(capability.unsupportedReason).toBeTruthy();
      expect(capability.unsupportedReason).not.toContain('mesmo subconjunto');
    }
  });
});

describe('execute', () => {
  it('lê o resource name do anúncio por GAQL antes de mutar', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(adFound())
      .mockResolvedValueOnce(mutated());

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(callOf(request, 0).url).toContain('googleAds:search');
    expect(callOf(request, 0).body?.query).toContain(
      'ad_group_ad.ad.id = 7788',
    );
    expect(callOf(request, 1).url).toBe(
      'https://googleads.googleapis.com/v24/customers/4444/adGroupAds:mutate',
    );
    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      update: { resourceName: AD_RESOURCE, status: 'PAUSED' },
      updateMask: 'status',
    });
  });

  it('usa resource name pronto sem consultar', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        target: { ...pauseAd.target, externalId: AD_RESOURCE },
      },
      ctx,
    );

    expect(request).toHaveBeenCalledTimes(1);
    expect(callOf(request).url).toContain('adGroupAds:mutate');
  });

  it('pausa grupo de anúncios por adGroups:mutate, com o resource name montado', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        type: 'PAUSE_AD_SET',
        level: 'AD_SET',
        target: { type: 'AD_SET', internalId: 'set-uuid', externalId: '9900' },
      },
      ctx,
    );

    expect(callOf(request).url).toContain('/adGroups:mutate');
    expect(callOf(request).body?.operations?.[0]).toMatchObject({
      update: {
        resourceName: 'customers/4444/adGroups/9900',
        status: 'PAUSED',
      },
      updateMask: 'status',
    });
  });

  it('reativa campanha por campaigns:mutate', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).execute(
      {
        ...pauseAd,
        type: 'ENABLE_CAMPAIGN',
        level: 'CAMPAIGN',
        target: { type: 'CAMPAIGN', internalId: 'c', externalId: '5500' },
      },
      ctx,
    );

    expect(callOf(request).url).toContain('/campaigns:mutate');
    expect(callOf(request).body?.operations?.[0]).toMatchObject({
      update: {
        resourceName: 'customers/4444/campaigns/5500',
        status: 'ENABLED',
      },
    });
  });

  it('recusa sem escrever quando o anúncio não é encontrado', async () => {
    const request = jest.fn().mockResolvedValue(search([]));

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result).toMatchObject({
      status: 'REJECTED_BY_PLATFORM',
      errorCode: 'TARGET_NOT_FOUND',
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('nunca interpola em GAQL um id que não é do Google', async () => {
    const request = jest.fn();
    const gateway = gatewayWith(request);
    const tampered = {
      ...pauseAd,
      target: { ...pauseAd.target, externalId: "1 OR ad_group_ad.ad.id > '0'" },
    };

    expect((await gateway.validate(tampered)).valid).toBe(false);
    expect((await gateway.execute(tampered, ctx)).status).toBe(
      'REJECTED_BY_PLATFORM',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('arquiva com remove, e não com update para REMOVED', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(adFound())
      .mockResolvedValueOnce(mutated());

    await gatewayWith(request).execute({ ...pauseAd, type: 'ARCHIVE_AD' }, ctx);

    expect(callOf(request, 1).body?.operations?.[0]).toEqual({
      remove: AD_RESOURCE,
    });
  });

  /**
   * Micros, não unidade menor: R$ 150,50 vira `150500000`. E o recurso é o
   * **orçamento** da campanha, lido pela campanha — o id da campanha como
   * `campaignBudgets` era recusado em toda chamada.
   */
  it('ajusta o orçamento diário da campanha, em micros e com updateMask', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(dailyBudget())
      .mockResolvedValueOnce(mutated());

    const result = await gatewayWith(request).execute(budget, ctx);

    expect(result.status).toBe('SUCCEEDED');
    expect(callOf(request, 0).body?.query).toContain('campaign.id = 5500');
    expect(callOf(request, 1).url).toContain('/campaignBudgets:mutate');
    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      update: {
        resourceName: 'customers/4444/campaignBudgets/77',
        amountMicros: '150500000',
      },
      updateMask: 'amount_micros',
    });
  });

  it('recusa orçamento compartilhado sem escrever', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(dailyBudget({ explicitlyShared: true }));

    const result = await gatewayWith(request).execute(budget, ctx);

    expect(result).toMatchObject({
      status: 'REJECTED_BY_PLATFORM',
      errorCode: 'BUDGET_SHARED',
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recusa orçamento total do período sem escrever', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(dailyBudget({ period: 'CUSTOM_PERIOD' }));

    const result = await gatewayWith(request).execute(budget, ctx);

    expect(result.errorCode).toBe('BUDGET_NOT_DAILY');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('carrega developer-token e login-customer-id', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).execute(
      { ...pauseAd, target: { ...pauseAd.target, externalId: AD_RESOURCE } },
      ctx,
    );

    expect(callOf(request).headers).toMatchObject({
      Authorization: 'Bearer token-1',
      'developer-token': 'dev-token',
      'login-customer-id': '111',
    });
  });

  it('devolve UNSUPPORTED sem tocar na rede no que a plataforma não faz', async () => {
    const request = jest.fn();

    const result = await gatewayWith(request).execute(
      { ...budget, type: 'ADJUST_AD_SET_BUDGET' },
      ctx,
    );

    expect(result.status).toBe('UNSUPPORTED');
    expect(request).not.toHaveBeenCalled();
  });
});

/**
 * **Paridade de erro declarada** — o gate de saída de A2-S8. As duas
 * plataformas classificam o mesmo status HTTP no mesmo desfecho de domínio.
 */
describe('paridade de erro com a Meta', () => {
  it.each([
    [400, 'REJECTED_BY_PLATFORM', false],
    [403, 'REJECTED_BY_PLATFORM', false],
    [404, 'REJECTED_BY_PLATFORM', false],
    [401, 'REJECTED_BY_PLATFORM', false],
    [429, 'FAILED', true],
    [500, 'FAILED', true],
  ])('classifica %s como %s', async (status, expected, retryable) => {
    const request = jest
      .fn()
      .mockRejectedValue(
        new PlatformRequestError(classifyPlatformError({ status }), 1),
      );

    const result = await gatewayWith(request).execute(pauseAd, ctx);

    expect(result.status).toBe(expected);
    expect(result.retryable).toBe(retryable);
  });
});

describe('revert', () => {
  it('restaura o status do próprio recurso, não o de entrega', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(adFound())
      .mockResolvedValueOnce(mutated());

    await gatewayWith(request).revert(
      pauseAd,
      { status: 'PAUSED', raw: { ownStatus: 'ENABLED' } },
      ctx,
    );

    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      update: { status: 'ENABLED' },
    });
  });

  it('não escreve de volta um status composto', async () => {
    const request = jest.fn();

    const result = await gatewayWith(request).revert(
      pauseAd,
      { status: 'DISAPPROVED' },
      ctx,
    );

    expect(result.errorCode).toBe('PREVIOUS_STATE_INCOMPLETE');
    expect(request).not.toHaveBeenCalled();
  });

  /**
   * `REMOVED` é terminal no Google (§13.1). `inverseActionOf` já recusa
   * `ARCHIVE_AD` antes de chegar aqui; esta é a segunda linha.
   */
  it('recusa restaurar a partir de REMOVED', async () => {
    const request = jest.fn();

    const result = await gatewayWith(request).revert(
      pauseAd,
      { status: 'REMOVED' },
      ctx,
    );

    expect(result).toMatchObject({
      status: 'UNSUPPORTED',
      errorCode: 'IRREVERSIBLE_STATE',
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('restaura orçamento a partir da unidade menor, convertendo para micros', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(dailyBudget())
      .mockResolvedValueOnce(mutated());

    await gatewayWith(request).revert(
      budget,
      { status: 'ENABLED', dailyBudgetMinor: '9900' },
      ctx,
    );

    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      update: { amountMicros: '99000000' },
    });
  });

  it('recusa reverter sem estado anterior', async () => {
    const result = await gatewayWith(jest.fn()).revert(pauseAd, null, ctx);

    expect(result.errorCode).toBe('PREVIOUS_STATE_MISSING');
  });
});

describe('observe', () => {
  /** O Google não tem `GET /{id}`: tudo se lê por GAQL. */
  it('lê o status efetivo do anúncio — pausa da campanha vence', async () => {
    const request = jest.fn().mockResolvedValue(
      search([
        {
          adGroupAd: { status: 'ENABLED' },
          adGroup: { status: 'ENABLED' },
          campaign: { status: 'PAUSED' },
        },
      ]),
    );

    const state = await gatewayWith(request).observe(pauseAd, ctx);

    expect(state.status).toBe('PAUSED');
    expect(callOf(request).url).toContain('googleAds:search');
    expect(callOf(request).body?.query).toContain('ad_group_ad.ad.id = 7788');
  });

  /**
   * Unidade menor, como declara `ObservedEntityState` e como a Meta responde.
   * Micros aqui eram lidos pela reversão como centavos — dez mil vezes o valor.
   */
  it('lê orçamento de campanha em unidade menor da moeda da conta', async () => {
    const request = jest.fn().mockResolvedValue(
      search([
        {
          campaign: { status: 'ENABLED' },
          campaignBudget: { amountMicros: '150500000', period: 'DAILY' },
        },
      ]),
    );

    const state = await gatewayWith(request).observe(budget, ctx);

    expect(state).toMatchObject({
      status: 'ENABLED',
      dailyBudgetMinor: '15050',
    });
  });

  it('devolve status nulo quando a consulta não acha o recurso', async () => {
    const request = jest.fn().mockResolvedValue(search([]));

    expect(
      (await gatewayWith(request).observe(pauseAd, ctx)).status,
    ).toBeNull();
  });
});

const HEADLINES = [
  { text: 'Aumente suas vendas', pinnedField: 'HEADLINE_1' },
  { text: 'Conheça nossa plataforma' },
  { text: 'Comece hoje' },
];

const rsaRow = (adOverrides: Record<string, unknown> = {}) =>
  search([
    {
      adGroup: { resourceName: 'customers/4444/adGroups/1' },
      adGroupAd: {
        ad: {
          id: '7788',
          type: 'RESPONSIVE_SEARCH_AD',
          finalUrls: ['https://loja.example'],
          responsiveSearchAd: {
            headlines: HEADLINES,
            descriptions: [
              { text: 'Otimize suas campanhas' },
              { text: 'Tenha mais resultados' },
            ],
            path1: 'ofertas',
          },
          ...adOverrides,
        },
      },
    },
  ]);

const replaceHeadline = (
  asset: Record<string, unknown> = {},
): AdActionCommand => ({
  type: 'REPLACE_COPY',
  level: 'AD',
  target: pauseAd.target,
  parameters: {
    schemaVersion: 1,
    adId: 'ad-uuid',
    aiAuthored: true,
    assetReplacement: {
      field: 'HEADLINE',
      index: 0,
      currentValue: 'Aumente suas vendas',
      value: 'Mais ROAS nas suas campanhas',
      ...asset,
    } as never,
  },
  accountCurrency: 'BRL',
});

/**
 * Decisão de produto: no anúncio de busca, trocar texto é substituir **um**
 * título ou **uma** descrição escolhidos pela pessoa — nunca a lista inteira,
 * nunca um acréscimo.
 */
describe('REPLACE_COPY no anúncio de busca', () => {
  it('troca só o título escolhido, preservando os demais e o pin', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(rsaRow())
      .mockResolvedValueOnce(mutated());

    const result = await gatewayWith(request).execute(replaceHeadline(), ctx);

    expect(result).toMatchObject({ status: 'SUCCEEDED' });
    // Edição em lugar: nenhum anúncio novo, nenhum sucessor para a linhagem.
    expect(result.platformEntityId).toBeUndefined();
    expect(callOf(request, 1).url).toBe(
      'https://googleads.googleapis.com/v24/customers/4444/ads:mutate',
    );
    expect(callOf(request, 1).body?.operations?.[0]).toEqual({
      update: {
        resourceName: 'customers/4444/ads/7788',
        responsiveSearchAd: {
          headlines: [
            { text: 'Mais ROAS nas suas campanhas', pinnedField: 'HEADLINE_1' },
            { text: 'Conheça nossa plataforma' },
            { text: 'Comece hoje' },
          ],
        },
      },
      updateMask: 'responsive_search_ad.headlines',
    });
  });

  it('troca a descrição escolhida com a máscara da lista de descrições', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(rsaRow())
      .mockResolvedValueOnce(mutated());

    await gatewayWith(request).execute(
      replaceHeadline({
        field: 'DESCRIPTION',
        index: 1,
        currentValue: 'Tenha mais resultados',
        value: 'Resultados medidos por anúncio',
      }),
      ctx,
    );

    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      update: {
        responsiveSearchAd: {
          descriptions: [
            { text: 'Otimize suas campanhas' },
            { text: 'Resultados medidos por anúncio' },
          ],
        },
      },
      updateMask: 'responsive_search_ad.descriptions',
    });
  });

  /**
   * Alguém editou o anúncio no gerenciador entre a escolha e o envio. Gravar
   * substituiria um texto que ninguém escolheu trocar.
   */
  it('recusa sem escrever quando o asset mudou desde a escolha', async () => {
    const request = jest.fn().mockResolvedValue(rsaRow());

    const result = await gatewayWith(request).execute(
      replaceHeadline({ currentValue: 'Texto que já não está lá' }),
      ctx,
    );

    expect(result).toMatchObject({
      status: 'REJECTED_BY_PLATFORM',
      errorCode: 'COPY_ASSET_CHANGED',
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recusa título acima de 30 caracteres sem tocar na rede', async () => {
    const request = jest.fn();
    const gateway = gatewayWith(request);
    const tooLong = replaceHeadline({
      value: 'Aumente o ROAS das suas campanhas',
    });

    expect((await gateway.validate(tooLong)).valid).toBe(false);
    expect((await gateway.execute(tooLong, ctx)).errorCode).toBe(
      'COPY_LENGTH_INVALID',
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('recusa texto que repete outro título do anúncio', async () => {
    const request = jest.fn().mockResolvedValue(rsaRow());

    const result = await gatewayWith(request).execute(
      replaceHeadline({ value: 'Comece hoje' }),
      ctx,
    );

    expect(result.errorCode).toBe('COPY_ASSET_DUPLICATE');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('exige o asset escolhido: texto principal não existe no Google', async () => {
    const request = jest.fn();

    const result = await gatewayWith(request).execute(
      {
        ...replaceHeadline(),
        parameters: {
          schemaVersion: 1,
          adId: 'ad-uuid',
          aiAuthored: true,
          primaryText: 'Texto principal',
        },
      },
      ctx,
    );

    expect(result.errorCode).toBe('COPY_ASSET_TARGET_REQUIRED');
    expect(request).not.toHaveBeenCalled();
  });

  it('recusa anúncio que não é de busca responsivo', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(rsaRow({ type: 'RESPONSIVE_DISPLAY_AD' }));

    const result = await gatewayWith(request).execute(replaceHeadline(), ctx);

    expect(result.errorCode).toBe('AD_TYPE_UNSUPPORTED');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('REPLACE_CTA no display e no Demand Gen', () => {
  const replaceCta = (
    callToAction = 'Peça uma demonstração',
  ): AdActionCommand => ({
    ...pauseAd,
    type: 'REPLACE_CTA',
    parameters: {
      schemaVersion: 1,
      adId: 'ad-uuid',
      callToAction,
      aiAuthored: true,
    },
  });

  const ctaRow = (ad: Record<string, unknown>) =>
    search([{ adGroupAd: { ad: { id: '7788', ...ad } } }]);

  const displayRow = (callToActionText = 'Saiba mais') =>
    ctaRow({
      type: 'RESPONSIVE_DISPLAY_AD',
      responsiveDisplayAd: { callToActionText },
    });

  it('grava o texto da chamada com a máscara do formato', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(displayRow())
      .mockResolvedValueOnce(mutated());

    const result = await gatewayWith(request).execute(replaceCta(), ctx);

    expect(result).toMatchObject({ status: 'SUCCEEDED' });
    // Edição em lugar: o anúncio continua sendo o mesmo.
    expect(result.platformEntityId).toBeUndefined();
    expect(callOf(request, 1).body?.operations?.[0]).toEqual({
      update: {
        resourceName: 'customers/4444/ads/7788',
        responsiveDisplayAd: { callToActionText: 'Peça uma demonstração' },
      },
      updateMask: 'responsive_display_ad.call_to_action_text',
    });
  });

  it('usa a máscara do Demand Gen quando o anúncio é de várias imagens', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(
        ctaRow({
          type: 'DEMAND_GEN_MULTI_ASSET_AD',
          demandGenMultiAssetAd: { callToActionText: 'Saiba mais' },
        }),
      )
      .mockResolvedValueOnce(mutated());

    await gatewayWith(request).execute(replaceCta(), ctx);

    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      updateMask: 'demand_gen_multi_asset_ad.call_to_action_text',
    });
  });

  it('recusa o anúncio de busca, que não tem o campo', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(ctaRow({ type: 'RESPONSIVE_SEARCH_AD' }));

    const result = await gatewayWith(request).execute(replaceCta(), ctx);

    expect(result).toMatchObject({
      status: 'REJECTED_BY_PLATFORM',
      errorCode: 'AD_TYPE_UNSUPPORTED',
    });
    expect(result.errorMessage).toContain('RESPONSIVE_SEARCH_AD');
    expect(request).toHaveBeenCalledTimes(1);
  });

  /**
   * Gravar a mesma chamada mandaria o anúncio de volta para revisão e
   * reiniciaria o aprendizado sem trocar uma letra.
   */
  it('recusa quando a chamada já é a que está no ar', async () => {
    const request = jest.fn().mockResolvedValue(displayRow('Saiba mais'));

    const result = await gatewayWith(request).execute(
      replaceCta('saiba mais'),
      ctx,
    );

    expect(result.errorCode).toBe('CTA_UNCHANGED');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recusa texto acima de 30 caracteres sem tocar na rede', async () => {
    const request = jest.fn();
    const gateway = gatewayWith(request);
    const tooLong = replaceCta('Peça agora mesmo a sua demonstração gratuita');

    expect((await gateway.validate(tooLong)).valid).toBe(false);
    expect((await gateway.execute(tooLong, ctx)).errorCode).toBe(
      'COPY_LENGTH_INVALID',
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe('DUPLICATE_AD no anúncio de busca', () => {
  const duplicate: AdActionCommand = { ...pauseAd, type: 'DUPLICATE_AD' };

  /** O Google aceita `PAUSED` na criação: não existe intervalo veiculando. */
  it('cria a cópia pausada no mesmo grupo e devolve o id novo', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(rsaRow())
      .mockResolvedValueOnce({
        data: {
          results: [{ resourceName: 'customers/4444/adGroupAds/1~9911' }],
        },
      });

    const result = await gatewayWith(request).execute(duplicate, ctx);

    expect(result).toMatchObject({
      status: 'SUCCEEDED',
      platformEntityId: '9911',
    });
    expect(callOf(request, 1).url).toContain('/adGroupAds:mutate');
    expect(callOf(request, 1).body?.operations?.[0]).toMatchObject({
      create: {
        adGroup: 'customers/4444/adGroups/1',
        status: 'PAUSED',
        ad: {
          finalUrls: ['https://loja.example'],
          responsiveSearchAd: {
            headlines: HEADLINES,
            path1: 'ofertas',
          },
        },
      },
    });
  });

  /**
   * A falha pode ter acontecido depois de o Google criar. Repetir produziria
   * uma segunda cópia.
   */
  it('falha de transporte na criação não volta à fila', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce(rsaRow())
      .mockRejectedValueOnce(
        new PlatformRequestError(classifyPlatformError({ status: 500 }), 1),
      );

    const result = await gatewayWith(request).execute(duplicate, ctx);

    expect(result).toMatchObject({ status: 'FAILED', retryable: false });
    expect(result.errorMessage).toContain('confira a conta');
  });

  it('recusa anúncio que não é de busca responsivo', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(rsaRow({ type: 'VIDEO_RESPONSIVE_AD' }));

    const result = await gatewayWith(request).execute(duplicate, ctx);

    expect(result.errorCode).toBe('AD_TYPE_UNSUPPORTED');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('grupo de recursos do Performance Max (D23)', () => {
  const onAssetGroup = (
    type: AdActionCommand['type'],
    externalId = 'asset_group:8800',
  ): AdActionCommand => ({
    ...pauseAd,
    type,
    target: { type: 'AD', internalId: 'unit-uuid', externalId },
  });

  it('declaram o grupo de recursos: pausar e reativar o grupo, e as ações de campanha', () => {
    const withUnit = gatewayWith(jest.fn())
      .capabilities()
      .filter((c) => c.units?.includes('ASSET_GROUP'))
      .map((c) => c.type)
      .sort();

    // A campanha PMax é campanha comum; trocar texto, duplicar e arquivar o
    // grupo seguem sem declaração.
    expect(withUnit).toEqual(
      [
        'ENABLE_AD',
        'PAUSE_AD',
        'PAUSE_CAMPAIGN',
        'ENABLE_CAMPAIGN',
        'ADJUST_CAMPAIGN_BUDGET',
      ].sort(),
    );
  });

  it('pausa por assetGroups:mutate, com o resource name montado e sem consulta', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    const result = await gatewayWith(request).execute(
      onAssetGroup('PAUSE_AD'),
      ctx,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(request).toHaveBeenCalledTimes(1);
    expect(callOf(request).url).toContain('/customers/4444/assetGroups:mutate');
    expect(callOf(request).body?.operations?.[0]).toEqual({
      update: {
        resourceName: 'customers/4444/assetGroups/8800',
        status: 'PAUSED',
      },
      updateMask: 'status',
    });
  });

  it('reativa com ENABLED', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).execute(onAssetGroup('ENABLE_AD'), ctx);

    expect(callOf(request).body?.operations?.[0]).toMatchObject({
      update: { status: 'ENABLED' },
    });
  });

  it('recusa sem tocar na rede o que não sabe escrever num grupo', async () => {
    for (const type of [
      'ARCHIVE_AD',
      'REPLACE_COPY',
      'DUPLICATE_AD',
    ] as const) {
      const request = jest.fn();

      const result = await gatewayWith(request).execute(
        onAssetGroup(type),
        ctx,
      );

      expect(result).toMatchObject({
        status: 'UNSUPPORTED',
        errorCode: 'ACTION_UNSUPPORTED_FOR_UNIT',
        retryable: false,
      });
      expect(request).not.toHaveBeenCalled();
    }
  });

  it('valida o id prefixado só no nível do anúncio', async () => {
    const gateway = gatewayWith(jest.fn());

    expect((await gateway.validate(onAssetGroup('PAUSE_AD'))).valid).toBe(true);
    expect(
      (await gateway.validate(onAssetGroup('PAUSE_AD', 'asset_group:1 OR 1=1')))
        .valid,
    ).toBe(false);
    expect(
      (
        await gateway.validate({
          ...pauseAd,
          type: 'PAUSE_CAMPAIGN',
          level: 'CAMPAIGN',
          target: {
            type: 'CAMPAIGN',
            internalId: 'camp-uuid',
            externalId: 'asset_group:8800',
          },
        })
      ).valid,
    ).toBe(false);
  });

  it('reverte para o status do próprio grupo', async () => {
    const request = jest.fn().mockResolvedValue(mutated());

    await gatewayWith(request).revert(
      onAssetGroup('PAUSE_AD'),
      { status: 'ENABLED', raw: { ownStatus: 'ENABLED' } },
      ctx,
    );

    expect(callOf(request).url).toContain('assetGroups:mutate');
    expect(callOf(request).body?.operations?.[0]).toMatchObject({
      update: {
        resourceName: 'customers/4444/assetGroups/8800',
        status: 'ENABLED',
      },
    });
  });

  it('observa pela mesma composição do sync — pausa da campanha vence', async () => {
    const request = jest
      .fn()
      .mockResolvedValue(
        search([
          { assetGroup: { status: 'ENABLED' }, campaign: { status: 'PAUSED' } },
        ]),
      );

    const state = await gatewayWith(request).observe(
      onAssetGroup('PAUSE_AD'),
      ctx,
    );

    expect(state.status).toBe('PAUSED');
    expect(state.raw).toMatchObject({ ownStatus: 'ENABLED' });
    expect(callOf(request).body?.query).toContain(
      'FROM asset_group WHERE asset_group.id = 8800',
    );
  });
});
