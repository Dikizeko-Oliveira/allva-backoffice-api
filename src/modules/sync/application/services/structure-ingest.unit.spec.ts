import type { ProviderAd } from 'src/modules/integrations/domain/ports';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { SyncableAdAccount } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { StructureIngestService } from './structure-ingest.service';

/**
 * **A unidade sem conjunto entra no domínio** (D23).
 *
 * O grupo de recursos do Performance Max pende direto da campanha. O perfil do
 * Google declara nível de conjunto, e a quarentena só pode exigi-lo de quem
 * trouxe referência a um conjunto: exigir de quem não tem mandaria todo grupo
 * de recursos para a quarentena, e o gasto do PMax continuaria fora da Allva.
 */

function account(platform: Platform): SyncableAdAccount {
  return {
    id: 'acc-1',
    accountId: 'owner-1',
    organizationId: 'org-1',
    platform,
    externalAccountId: 'ext-1',
    name: 'Conta',
    integrationId: 'int-1',
    integrationStatus: 'CONNECTED',
    currency: 'BRL',
    timezone: 'America/Sao_Paulo',
    attributionWindowDays: 7,
    restatementWindowDays: 14,
    syncHealth: 'HEALTHY',
    syncHealthReason: null,
    unreachableSince: null,
    lastSuccessfulFullSyncAt: null,
    lastFullSyncAt: null,
    baseCurrency: 'BRL',
    currencyState: 'STABLE',
  };
}

function harness() {
  const structure = {
    mapCampaignIds: jest.fn().mockResolvedValue(new Map()),
    upsertCampaign: jest.fn().mockResolvedValue('campaign-id'),
    mapAdSetIds: jest.fn().mockResolvedValue(new Map()),
    upsertAdSet: jest.fn().mockResolvedValue('ad-set-id'),
    mapCreativeIds: jest.fn().mockResolvedValue(new Map()),
    upsertCreative: jest.fn().mockResolvedValue('creative-id'),
    findAdsByExternalIds: jest.fn().mockResolvedValue([]),
    upsertAd: jest.fn(),
  };
  const quarantine = {
    listOpen: jest.fn().mockResolvedValue([]),
    record: jest.fn(),
    resolve: jest.fn(),
  };
  const lineage = { findOriginFor: jest.fn().mockResolvedValue(new Map()) };

  const service = new StructureIngestService(
    structure as never,
    quarantine as never,
    lineage as never,
  );

  return { service, structure, quarantine };
}

const NOW = new Date('2026-09-22T12:00:00.000Z');

const unit = (overrides: Partial<ProviderAd> = {}): ProviderAd => ({
  externalAdId: 'asset_group:8800',
  adSetExternalId: null,
  campaignExternalId: 'c1',
  creativeExternalId: 'asset_group:8800',
  unitKind: 'ASSET_GROUP',
  name: 'Grupo — Verão',
  status: 'ENABLED',
  ...overrides,
});

async function ingest(ads: ProviderAd[]) {
  const { service, structure, quarantine } = harness();
  structure.mapCampaignIds.mockResolvedValue(new Map([['c1', 'campaign-id']]));
  structure.upsertAd.mockResolvedValue({ id: 'ad-id', lineageId: 'ad-id' });

  await service.apply({
    account: account('GOOGLE'),
    integrationId: 'int-1',
    campaigns: [{ externalCampaignId: 'c1', name: 'PMax' }],
    adSets: [],
    ads,
    creatives: [],
    fullScan: true,
    syncStartedAt: NOW,
    now: NOW,
  });

  return { structure, quarantineRecord: quarantine.record };
}

describe('StructureIngestService — unidade analisada', () => {
  it('grupo de recursos entra sem conjunto, com a unidade gravada', async () => {
    const { structure, quarantineRecord } = await ingest([unit()]);

    expect(quarantineRecord).not.toHaveBeenCalled();
    expect(structure.upsertAd).toHaveBeenCalledWith(
      expect.objectContaining({
        externalAdId: 'asset_group:8800',
        campaignId: 'campaign-id',
        adSetId: null,
        unitKind: 'ASSET_GROUP',
      }),
    );
  });

  it('provider que não declara a unidade grava anúncio', async () => {
    const { structure } = await ingest([
      unit({ externalAdId: '7788', unitKind: undefined }),
    ]);

    expect(structure.upsertAd.mock.calls[0][0].unitKind).toBe('AD');
  });

  it('anúncio com conjunto que não resolveu continua indo para a quarentena', async () => {
    const { structure, quarantineRecord } = await ingest([
      unit({
        externalAdId: '7788',
        adSetExternalId: 's-missing',
        unitKind: 'AD',
      }),
    ]);

    expect(structure.upsertAd).not.toHaveBeenCalled();
    expect(quarantineRecord).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'AD_SET_NOT_RESOLVED' }),
    );
  });
});
