import {
  classifyTikTokAdGroup,
  classifyTikTokCampaign,
} from './tiktok-optimization';

describe('classifyTikTokAdGroup', () => {
  it.each([
    ['SHOPPING', 'PURCHASE'],
    ['FORM', 'LEAD'],
    ['ON_WEB_REGISTER', 'COMPLETE_REGISTRATION'],
    ['ON_WEB_CART', 'ADD_TO_CART'],
    ['EVENTO_NOVO', 'OTHER'],
  ])('CONVERT com evento %s conta %s', (event, canonical) => {
    expect(
      classifyTikTokAdGroup({
        optimizationGoal: 'CONVERT',
        optimizationEvent: event,
      }),
    ).toEqual({
      optimizationClass: 'CONVERSION',
      conversionEvent: canonical,
      // Quem conta é a plataforma: a métrica `conversion` já é o evento do grupo.
      conversionMeasurable: true,
    });
  });

  it.each([
    ['INSTALL', 'APP_INSTALL'],
    ['LEAD_GENERATION', 'LEAD'],
    ['CONVERSATION', 'MESSAGING_CONVERSATION'],
  ])('%s é conversão (%s)', (goal, event) => {
    expect(
      classifyTikTokAdGroup({ optimizationGoal: goal })?.conversionEvent,
    ).toBe(event);
  });

  it.each([
    ['CLICK', 'TRAFFIC'],
    ['REACH', 'AWARENESS'],
    ['VIDEO_VIEW', 'AWARENESS'],
    ['FOLLOWERS', 'ENGAGEMENT'],
  ])('%s → %s', (goal, cls) => {
    expect(
      classifyTikTokAdGroup({ optimizationGoal: goal })?.optimizationClass,
    ).toBe(cls);
  });

  it('meta desconhecida devolve null — vale o objetivo da campanha', () => {
    expect(classifyTikTokAdGroup({ optimizationGoal: 'META_NOVA' })).toBeNull();
  });
});

describe('classifyTikTokCampaign', () => {
  it.each([
    ['WEB_CONVERSIONS', 'CONVERSION'],
    ['LEAD_GENERATION', 'CONVERSION'],
    ['TRAFFIC', 'TRAFFIC'],
    ['REACH', 'AWARENESS'],
    ['ENGAGEMENT', 'ENGAGEMENT'],
    [undefined, 'UNKNOWN'],
  ])('%s → %s', (objective, cls) => {
    expect(classifyTikTokCampaign(objective).optimizationClass).toBe(cls);
  });
});
