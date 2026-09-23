import {
  classifyGoogleCampaign,
  eventFromGoalCategories,
} from './google-optimization';

describe('classifyGoogleCampaign', () => {
  it.each([
    'TARGET_CPA',
    'MAXIMIZE_CONVERSIONS',
    'TARGET_ROAS',
    'MAXIMIZE_CONVERSION_VALUE',
  ])('lance de conversão %s é conversão contável', (bidding) => {
    const target = classifyGoogleCampaign({
      channelType: 'SEARCH',
      biddingStrategyType: bidding,
      biddableGoalCategories: ['PURCHASE'],
    });
    expect(target).toEqual({
      optimizationClass: 'CONVERSION',
      conversionEvent: 'PURCHASE',
      conversionMeasurable: true,
    });
  });

  it('lance manual com meta lançável é conversão', () => {
    expect(
      classifyGoogleCampaign({
        channelType: 'SEARCH',
        biddingStrategyType: 'MANUAL_CPC',
        biddableGoalCategories: ['SUBMIT_LEAD_FORM'],
      }).conversionEvent,
    ).toBe('LEAD');
  });

  it('lance manual sem meta, ou sem saber as metas, é tráfego — nunca cobra conversão às cegas', () => {
    for (const categories of [[], null]) {
      expect(
        classifyGoogleCampaign({
          channelType: 'SEARCH',
          biddingStrategyType: 'MANUAL_CPC',
          biddableGoalCategories: categories,
        }).optimizationClass,
      ).toBe('TRAFFIC');
    }
  });

  it.each([
    ['TARGET_SPEND', 'TRAFFIC'],
    ['TARGET_CPM', 'AWARENESS'],
    ['MANUAL_CPV', 'AWARENESS'],
    ['TARGET_IMPRESSION_SHARE', 'AWARENESS'],
  ])('%s → %s', (bidding, cls) => {
    expect(
      classifyGoogleCampaign({
        channelType: 'VIDEO',
        biddingStrategyType: bidding,
        biddableGoalCategories: ['PURCHASE'],
      }).optimizationClass,
    ).toBe(cls);
  });

  it('Performance Max sem lance declarado é conversão pelo canal', () => {
    expect(
      classifyGoogleCampaign({
        channelType: 'PERFORMANCE_MAX',
        biddingStrategyType: null,
        biddableGoalCategories: null,
      }),
    ).toEqual({
      optimizationClass: 'CONVERSION',
      conversionEvent: 'OTHER',
      conversionMeasurable: true,
    });
  });

  it('canal e lance desconhecidos ficam UNKNOWN', () => {
    expect(
      classifyGoogleCampaign({
        channelType: 'DISPLAY',
        biddingStrategyType: 'UNSPECIFIED',
        biddableGoalCategories: [],
      }).optimizationClass,
    ).toBe('UNKNOWN');
  });
});

describe('eventFromGoalCategories', () => {
  it('categorias que viram o mesmo evento contam como um', () => {
    expect(
      eventFromGoalCategories(['SUBMIT_LEAD_FORM', 'QUALIFIED_LEAD']),
    ).toBe('LEAD');
  });

  it('eventos diferentes viram MULTIPLE', () => {
    expect(eventFromGoalCategories(['PURCHASE', 'SIGNUP'])).toBe('MULTIPLE');
  });

  it('categoria sem equivalente é OTHER', () => {
    expect(eventFromGoalCategories(['OUTBOUND_CLICK'])).toBe('OTHER');
  });
});
