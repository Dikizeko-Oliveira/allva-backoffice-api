import {
  planSmartPlusGapFill,
  SMART_PLUS_FORMAT,
  smartPlusMetricValues,
  type SmartPlusAdNode,
  toSmartPlusAd,
  toSmartPlusCreative,
} from './tiktok-smart-plus';

/**
 * A regra de lacunas do Smart+ (D24) nas três respostas possíveis da conta
 * real: as rotas padrão cobrem, não cobrem, ou cobrem sob outro id. Nas três,
 * o gasto de um anúncio não pode entrar duas vezes.
 */

const smartAd = (
  id: string,
  campaignId = 'sc1',
  overrides: Partial<SmartPlusAdNode> = {},
): SmartPlusAdNode => ({
  smart_plus_ad_id: id,
  ad_name: `Smart+ ${id}`,
  adgroup_id: 'sg1',
  campaign_id: campaignId,
  operation_status: 'ENABLE',
  secondary_status: 'AD_STATUS_DELIVERY_OK',
  ...overrides,
});

const plan = (input: Partial<Parameters<typeof planSmartPlusGapFill>[0]>) =>
  planSmartPlusGapFill({
    standardCampaignIds: new Set(),
    standardAdGroupIds: new Set(),
    standardAds: new Map(),
    smartCampaigns: [],
    smartAdGroups: [],
    smartAds: [],
    ...input,
  });

describe('planSmartPlusGapFill', () => {
  it('rota padrão não enxerga o Smart+: tudo entra pela rota própria', () => {
    const result = plan({
      smartCampaigns: [{ campaign_id: 'sc1' }],
      smartAdGroups: [{ adgroup_id: 'sg1' }],
      smartAds: [smartAd('s1'), smartAd('s2')],
    });

    expect(result.campaigns).toEqual([{ campaign_id: 'sc1' }]);
    expect(result.adGroups).toEqual([{ adgroup_id: 'sg1' }]);
    expect(result.additions.map((ad) => ad.smart_plus_ad_id)).toEqual([
      's1',
      's2',
    ]);
    expect(result.replacements).toEqual([]);
  });

  it('rota padrão já cobre, com o mesmo id: troca a representação, não soma', () => {
    const result = plan({
      standardCampaignIds: new Set(['sc1']),
      standardAdGroupIds: new Set(['sg1']),
      standardAds: new Map([['s1', 'sc1']]),
      smartCampaigns: [{ campaign_id: 'sc1' }],
      smartAdGroups: [{ adgroup_id: 'sg1' }],
      smartAds: [smartAd('s1')],
    });

    expect(result.campaigns).toEqual([]);
    expect(result.adGroups).toEqual([]);
    expect(result.replacements.map((ad) => ad.smart_plus_ad_id)).toEqual([
      's1',
    ]);
    expect(result.additions).toEqual([]);
  });

  it('rota padrão cobre a campanha sob outro id: ignora, porque somaria em dobro', () => {
    const result = plan({
      standardAds: new Map([['a-padrao', 'sc1']]),
      smartAds: [smartAd('s1')],
    });

    expect(result.additions).toEqual([]);
    expect(result.replacements).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  it('a cobertura é por campanha: outra campanha Smart+ entra normalmente', () => {
    const result = plan({
      standardAds: new Map([['a-padrao', 'sc1']]),
      smartAds: [smartAd('s1', 'sc1'), smartAd('s2', 'sc2')],
    });

    expect(result.additions.map((ad) => ad.smart_plus_ad_id)).toEqual(['s2']);
    expect(result.ignored).toBe(1);
  });

  it('refresh dirigido: o id que só a rota própria devolveu é unidade Smart+', () => {
    const result = plan({
      standardAds: new Map([['a-padrao', 'sc1']]),
      smartAds: [smartAd('s1', 'sc1')],
      targeted: true,
    });

    expect(result.additions.map((ad) => ad.smart_plus_ad_id)).toEqual(['s1']);
  });

  it('descarta nó sem id, campanha ou grupo — não há onde pendurá-lo', () => {
    const result = plan({
      smartAds: [
        smartAd('s1', 'sc1', { smart_plus_ad_id: undefined }),
        smartAd('s2', 'sc1', { adgroup_id: undefined }),
      ],
    });

    expect(result.additions).toEqual([]);
  });
});

describe('toSmartPlusAd', () => {
  it('é pacote de recursos, com grupo, sem prefixo no id', () => {
    expect(toSmartPlusAd(smartAd('s1'))).toMatchObject({
      externalAdId: 's1',
      adSetExternalId: 'sg1',
      campaignExternalId: 'sc1',
      creativeExternalId: 's1',
      unitKind: 'ASSET_GROUP',
      name: 'Smart+ s1',
      status: 'AD_STATUS_DELIVERY_OK',
    });
  });
});

describe('toSmartPlusCreative', () => {
  const node = smartAd('s1', 'sc1', {
    creative_list: [
      {
        ad_material_id: 'm1',
        material_operation_status: 'ENABLE',
        creative_info: {
          ad_format: 'SINGLE_VIDEO',
          video_info: { video_id: 'v1' },
        },
      },
      {
        ad_material_id: 'm2',
        creative_info: {
          ad_format: 'CAROUSEL_ADS',
          image_info: [{ web_uri: 'tos-interno/abc' }],
        },
      },
    ],
    ad_text_list: [{ ad_text: 'Primeiro texto' }, { ad_text: ' Segundo ' }],
    call_to_action_list: [{ call_to_action: 'SHOP_NOW' }],
    landing_page_url_list: [{ landing_page_url: 'https://loja.example.com' }],
  });

  it('o pacote inteiro vira um criativo, com a miniatura do primeiro vídeo', () => {
    const creative = toSmartPlusCreative(
      node,
      new Map([['v1', { coverUrl: 'https://cdn/c.jpg', previewUrl: null }]]),
    );

    expect(creative).toMatchObject({
      externalCreativeId: 's1',
      body: 'Primeiro texto',
      callToAction: 'SHOP_NOW',
      format: SMART_PLUS_FORMAT,
      thumbnailUrl: 'https://cdn/c.jpg',
      landingPageUrl: 'https://loja.example.com',
      // `web_uri` é chave interna, não endereço.
      imageUrl: null,
    });
    expect(creative.metadata).toMatchObject({
      copyAssets: {
        descriptions: [
          { index: 0, text: 'Primeiro texto' },
          { index: 1, text: 'Segundo' },
        ],
      },
      creativeCount: 2,
      materials: [
        { adMaterialId: 'm1', adFormat: 'SINGLE_VIDEO', videoId: 'v1' },
        { adMaterialId: 'm2', adFormat: 'CAROUSEL_ADS', videoId: null },
      ],
    });
  });
});

describe('smartPlusMetricValues', () => {
  it('receita é ROAS × gasto; CTR e CPC saem dos insumos', () => {
    expect(
      smartPlusMetricValues({
        spend: '100',
        impressions: '4000',
        clicks: '80',
        complete_payment_roas: '2.5',
      }),
    ).toMatchObject({ total_purchase_value: '250', ctr: '2', cpc: '1.25' });
  });

  it('sem ROAS na linha, não inventa receita', () => {
    expect(
      smartPlusMetricValues({ spend: '100', impressions: '0', clicks: '0' }),
    ).not.toHaveProperty('total_purchase_value');
  });

  it('não sobrescreve CTR que a plataforma mandou', () => {
    expect(
      smartPlusMetricValues({ ctr: '3.1', impressions: '100', clicks: '1' })
        .ctr,
    ).toBe('3.1');
  });
});
