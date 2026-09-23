import {
  countMetaConversions,
  resolveMetaAdSetOptimization,
  resolveMetaCampaignOptimization,
} from './meta-conversion-events';

const actions = (entries: Record<string, number>) =>
  Object.entries(entries).map(([action_type, value]) => ({
    action_type,
    value: String(value),
  }));

describe('resolveMetaAdSetOptimization', () => {
  it('OFFSITE_CONVERSIONS lê o evento do promoted_object', () => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      promotedObject: { custom_event_type: 'LEAD', pixel_id: '1' },
    });
    expect(spec?.target).toEqual({
      optimizationClass: 'CONVERSION',
      conversionEvent: 'LEAD',
      conversionMeasurable: true,
    });
    expect(spec?.actionTypes[0]).toBe('lead');
  });

  it.each([
    ['COMPLETE_REGISTRATION', 'COMPLETE_REGISTRATION'],
    ['ADD_TO_CART', 'ADD_TO_CART'],
    ['INITIATED_CHECKOUT', 'INITIATED_CHECKOUT'],
    ['CONTACT', 'CONTACT'],
    ['SCHEDULE', 'SCHEDULE'],
    ['SUBSCRIBE', 'SUBSCRIBE'],
    ['MESSAGING_CONVERSATION_STARTED_7D', 'MESSAGING_CONVERSATION'],
  ])('evento %s vira %s contável', (metaEvent, canonical) => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      promotedObject: { custom_event_type: metaEvent },
    });
    expect(spec?.target.conversionEvent).toBe(canonical);
    expect(spec?.target.conversionMeasurable).toBe(true);
    expect(spec?.actionTypes.length).toBeGreaterThan(0);
  });

  it('conversão personalizada conta pelo id', () => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      promotedObject: { custom_conversion_id: '98765' },
    });
    expect(spec?.target.conversionEvent).toBe('CUSTOM_CONVERSION');
    expect(spec?.actionTypes).toEqual(['offsite_conversion.custom.98765']);
  });

  it('formulário nativo (LEAD_GENERATION) prefere o lead do formulário', () => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'LEAD_GENERATION',
    });
    expect(spec?.target.conversionEvent).toBe('LEAD');
    expect(spec?.actionTypes[0]).toBe('onsite_conversion.lead_grouped');
  });

  it('otimização de valor sem evento declarado assume compra', () => {
    const spec = resolveMetaAdSetOptimization({ optimizationGoal: 'VALUE' });
    expect(spec?.target.conversionEvent).toBe('PURCHASE');
  });

  it.each([
    ['OTHER', 'OTHER'],
    ['D7_RETENTION', 'APP_EVENT'],
  ])(
    'evento %s é conversão, mas não contável — o insights não o separa',
    (metaEvent, canonical) => {
      const spec = resolveMetaAdSetOptimization({
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        promotedObject: { custom_event_type: metaEvent },
      });
      expect(spec?.target.optimizationClass).toBe('CONVERSION');
      expect(spec?.target.conversionEvent).toBe(canonical);
      expect(spec?.target.conversionMeasurable).toBe(false);
    },
  );

  it.each([
    ['LINK_CLICKS', 'TRAFFIC'],
    ['LANDING_PAGE_VIEWS', 'TRAFFIC'],
    ['REACH', 'AWARENESS'],
    ['THRUPLAY', 'AWARENESS'],
    ['POST_ENGAGEMENT', 'ENGAGEMENT'],
  ])('%s não é conversão (%s)', (goal, cls) => {
    const spec = resolveMetaAdSetOptimization({ optimizationGoal: goal });
    expect(spec?.target.optimizationClass).toBe(cls);
    expect(spec?.target.conversionEvent).toBeNull();
  });

  it('meta sem significado devolve null — vale o objetivo da campanha', () => {
    expect(
      resolveMetaAdSetOptimization({ optimizationGoal: 'NONE' }),
    ).toBeNull();
    expect(resolveMetaAdSetOptimization({ optimizationGoal: null })).toBeNull();
  });
});

describe('resolveMetaCampaignOptimization', () => {
  it.each([
    ['OUTCOME_SALES', 'CONVERSION'],
    ['OUTCOME_LEADS', 'CONVERSION'],
    ['OUTCOME_APP_PROMOTION', 'CONVERSION'],
    ['OUTCOME_TRAFFIC', 'TRAFFIC'],
    ['OUTCOME_AWARENESS', 'AWARENESS'],
    ['OUTCOME_ENGAGEMENT', 'ENGAGEMENT'],
    ['OBJETIVO_NOVO', 'UNKNOWN'],
  ])('%s → %s', (objective, cls) => {
    expect(
      resolveMetaCampaignOptimization(objective).target.optimizationClass,
    ).toBe(cls);
  });
});

describe('countMetaConversions', () => {
  it('conta o evento do conjunto, não a compra', () => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'OFFSITE_CONVERSIONS',
      promotedObject: { custom_event_type: 'LEAD' },
    });
    const counted = countMetaConversions(
      {
        actions: actions({ lead: 12, purchase: 1, landing_page_view: 300 }),
        cost_per_action_type: actions({ lead: 8.5, purchase: 90 }),
      },
      spec,
    );
    expect(counted.conversions).toBe(12);
    expect(counted.cpa).toBe(8.5);
    // Lead sem valor: receita zero, e nunca a receita de compra somada a ele.
    expect(counted.revenue).toBe(0);
  });

  it('tipos sobrepostos contam uma vez só — o mais abrangente', () => {
    const spec = resolveMetaCampaignOptimization('OUTCOME_SALES');
    const counted = countMetaConversions(
      {
        actions: actions({
          omni_purchase: 7,
          purchase: 6,
          'offsite_conversion.fb_pixel_purchase': 6,
        }),
        action_values: actions({ omni_purchase: 700, purchase: 600 }),
      },
      spec,
    );
    expect(counted.conversions).toBe(7);
    expect(counted.revenue).toBe(700);
  });

  it('receita e custo vêm do mesmo tipo que a contagem usou', () => {
    const spec = resolveMetaCampaignOptimization('OUTCOME_SALES');
    const counted = countMetaConversions(
      {
        actions: actions({ purchase: 4 }),
        action_values: actions({ omni_purchase: 999, purchase: 400 }),
        cost_per_action_type: actions({ purchase: 25 }),
      },
      spec,
    );
    expect(counted.conversions).toBe(4);
    expect(counted.revenue).toBe(400);
    expect(counted.cpa).toBe(25);
  });

  it('evento de conversão sem ocorrência na linha é zero, não compra', () => {
    const spec = resolveMetaAdSetOptimization({
      optimizationGoal: 'LEAD_GENERATION',
    });
    expect(
      countMetaConversions({ actions: actions({ purchase: 3 }) }, spec)
        .conversions,
    ).toBe(0);
  });

  it('tráfego e evento não contável registram a compra incidental', () => {
    const traffic = resolveMetaAdSetOptimization({
      optimizationGoal: 'LINK_CLICKS',
    });
    expect(
      countMetaConversions(
        { actions: actions({ purchase: 2, lead: 5 }) },
        traffic,
      ).conversions,
    ).toBe(2);
    expect(
      countMetaConversions({ actions: actions({ purchase: 2 }) }, null)
        .conversions,
    ).toBe(2);
  });

  it('linha sem actions não converte', () => {
    expect(countMetaConversions({}, null)).toEqual({
      conversions: 0,
      revenue: 0,
      cpa: null,
    });
  });
});
