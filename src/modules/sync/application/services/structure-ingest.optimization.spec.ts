import {
  conversionTarget,
  nonConversionTarget,
  UNKNOWN_OPTIMIZATION,
} from 'src/modules/integrations/domain/entities/optimization-target';
import type {
  ProviderAdSet,
  ProviderCampaign,
} from 'src/modules/integrations/domain/ports';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { SyncableAdAccount } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { StructureIngestService } from './structure-ingest.service';

/**
 * O trecho do meio da ponta a ponta: o que o provider traduziu chega ao
 * repositório **sem se perder** — nas três plataformas, pelo mesmo caminho.
 *
 * O provider é quem traduz (P6); o ingest só repassa. Um campo esquecido aqui
 * deixaria o objetivo certo no provider e `NULL` no banco — e `NULL` resolve
 * para `UNKNOWN`, que desliga todos os detectores de conversão da conta.
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
  const lineage = { findOriginFor: jest.fn().mockResolvedValue(null) };

  const service = new StructureIngestService(
    structure as never,
    quarantine as never,
    lineage as never,
  );

  return { service, structure };
}

const campaign = (
  optimization: ProviderCampaign['optimization'],
): ProviderCampaign => ({
  externalCampaignId: 'c1',
  name: 'Campanha',
  objective: 'X',
  optimization,
});

const adSet = (
  id: string,
  optimization: ProviderAdSet['optimization'],
): ProviderAdSet => ({
  externalAdSetId: id,
  campaignExternalId: 'c1',
  name: `Conjunto ${id}`,
  optimization,
});

const NOW = new Date('2026-09-22T12:00:00.000Z');

describe.each(['META', 'GOOGLE', 'TIKTOK'] as const)(
  'StructureIngestService — objetivo de otimização (%s)',
  (platform) => {
    it('repassa o objetivo de campanha e conjunto ao repositório', async () => {
      const { service, structure } = harness();

      await service.apply({
        account: account(platform),
        integrationId: 'int-1',
        campaigns: [campaign(nonConversionTarget('AWARENESS'))],
        adSets: [
          adSet('s1', conversionTarget('LEAD')),
          adSet('s2', UNKNOWN_OPTIMIZATION),
        ],
        ads: [],
        creatives: [],
        fullScan: true,
        syncStartedAt: NOW,
        now: NOW,
      });

      expect(structure.upsertCampaign).toHaveBeenCalledWith(
        expect.objectContaining({
          optimization: nonConversionTarget('AWARENESS'),
        }),
      );
      expect(structure.upsertAdSet).toHaveBeenCalledWith(
        expect.objectContaining({
          externalAdSetId: 's1',
          optimization: conversionTarget('LEAD'),
        }),
      );
      // `UNKNOWN` explícito também é repassado: foi lido, e diz que a meta não
      // decide — quem decide é a campanha.
      expect(structure.upsertAdSet).toHaveBeenCalledWith(
        expect.objectContaining({
          externalAdSetId: 's2',
          optimization: UNKNOWN_OPTIMIZATION,
        }),
      );
    });

    it('não inventa objetivo quando o provider não leu', async () => {
      const { service, structure } = harness();

      await service.apply({
        account: account(platform),
        integrationId: 'int-1',
        campaigns: [campaign(undefined)],
        adSets: [adSet('s1', undefined)],
        ads: [],
        creatives: [],
        fullScan: true,
        syncStartedAt: NOW,
        now: NOW,
      });

      // `undefined` segue adiante: é o repositório que decide preservar o que
      // já estava gravado.
      expect(
        structure.upsertCampaign.mock.calls[0][0].optimization,
      ).toBeUndefined();
      expect(
        structure.upsertAdSet.mock.calls[0][0].optimization,
      ).toBeUndefined();
    });
  },
);
