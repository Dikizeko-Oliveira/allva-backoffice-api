import {
  summarizeCoverage,
  type CampaignCoverageRow,
} from './campaign-coverage';

const row = (overrides: Partial<CampaignCoverageRow>): CampaignCoverageRow => ({
  campaignId: 'c1',
  campaignName: 'Campanha',
  platform: 'TIKTOK',
  rawStatus: 'CAMPAIGN_STATUS_ENABLE',
  objective: 'WEB_CONVERSIONS',
  adAccountName: 'Conta',
  ...overrides,
});

describe('summarizeCoverage', () => {
  it('campanha ativa sem anúncio analisável entra, com o motivo', () => {
    const summary = summarizeCoverage([row({})]);

    expect(summary.total).toBe(1);
    expect(summary.uncoveredCampaigns[0].reason).toBe('NO_ANALYZABLE_ADS');
    expect(summary.byPlatform).toEqual({ TIKTOK: 1 });
  });

  it.each([
    ['META', 'ACTIVE'],
    ['GOOGLE', 'ENABLED'],
    ['TIKTOK', 'CAMPAIGN_STATUS_ENABLE'],
    ['TIKTOK', 'CAMPAIGN_STATUS_BUDGET_EXCEED'],
  ] as const)('%s com status %s é ativa', (platform, rawStatus) => {
    expect(summarizeCoverage([row({ platform, rawStatus })]).total).toBe(1);
  });

  it.each([
    ['META', 'PAUSED'],
    ['GOOGLE', 'PAUSED'],
    ['TIKTOK', 'CAMPAIGN_STATUS_DISABLE'],
  ] as const)('%s pausada (%s) não é lacuna', (platform, rawStatus) => {
    expect(summarizeCoverage([row({ platform, rawStatus })]).total).toBe(0);
  });

  it('status que não sabemos ler fica de fora — alarme falso é pior que silêncio', () => {
    expect(
      summarizeCoverage([
        row({ rawStatus: 'STATUS_NOVO' }),
        row({ campaignId: 'c2', rawStatus: null }),
      ]).total,
    ).toBe(0);
  });

  it('conta por plataforma', () => {
    const summary = summarizeCoverage([
      row({ campaignId: 'c1' }),
      row({ campaignId: 'c2' }),
      row({ campaignId: 'c3', platform: 'META', rawStatus: 'ACTIVE' }),
    ]);
    expect(summary.byPlatform).toEqual({ META: 1, TIKTOK: 2 });
  });
});
