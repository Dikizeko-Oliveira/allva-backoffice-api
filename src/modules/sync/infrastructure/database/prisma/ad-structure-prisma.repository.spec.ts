import { conversionTarget } from 'src/modules/integrations/domain/entities/optimization-target';
import type {
  UpsertAdSetInput,
  UpsertCampaignInput,
} from 'src/modules/sync/domain/ports/ad-structure.repository';
import { AdStructurePrismaRepository } from './ad-structure-prisma.repository';

/**
 * O fim da ponta a ponta: as três colunas do objetivo chegam ao banco — e
 * **não são apagadas** quando o provider não as leu.
 *
 * A segunda metade é a que protege a conta: um sync parcial que não trouxe o
 * objetivo não pode zerar o que o sync anterior gravou. `NULL` resolve para
 * `UNKNOWN`, e `UNKNOWN` desliga os detectores de conversão do anúncio.
 */

function harness() {
  const prisma = {
    campaign: { upsert: jest.fn().mockResolvedValue({ id: 'campaign-id' }) },
    adSet: { upsert: jest.fn().mockResolvedValue({ id: 'ad-set-id' }) },
  };
  const repository = new AdStructurePrismaRepository(prisma as never);
  return { prisma, repository };
}

const campaignInput = (
  optimization: UpsertCampaignInput['optimization'],
): UpsertCampaignInput => ({
  adAccountId: 'acc-1',
  organizationId: 'org-1',
  integrationId: 'int-1',
  platform: 'GOOGLE',
  externalCampaignId: 'c1',
  name: 'Campanha',
  status: 'ENABLED',
  objective: 'SEARCH',
  optimization,
  dailyBudget: null,
  lifetimeBudget: null,
  currency: 'BRL',
  startedAt: null,
  endedAt: null,
  metadata: null,
});

const adSetInput = (
  optimization: UpsertAdSetInput['optimization'],
): UpsertAdSetInput => ({
  adAccountId: 'acc-1',
  organizationId: 'org-1',
  campaignId: 'campaign-id',
  platform: 'TIKTOK',
  externalAdSetId: 's1',
  name: 'Grupo',
  status: 'ENABLE',
  optimizationGoal: 'CONVERT',
  billingEvent: null,
  optimization,
  dailyBudget: null,
  lifetimeBudget: null,
  targeting: null,
});

const LEAD_COLUMNS = {
  optimizationClass: 'CONVERSION',
  conversionEvent: 'LEAD',
  conversionMeasurable: true,
};

const COLUMN_NAMES = [
  'optimizationClass',
  'conversionEvent',
  'conversionMeasurable',
];

describe('AdStructurePrismaRepository — colunas do objetivo', () => {
  it('campanha: grava as três colunas na criação e na atualização', async () => {
    const { prisma, repository } = harness();

    await repository.upsertCampaign(campaignInput(conversionTarget('LEAD')));

    const call = prisma.campaign.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject(LEAD_COLUMNS);
    expect(call.update).toMatchObject(LEAD_COLUMNS);
  });

  it('conjunto: grava as três colunas na criação e na atualização', async () => {
    const { prisma, repository } = harness();

    await repository.upsertAdSet(adSetInput(conversionTarget('LEAD')));

    const call = prisma.adSet.upsert.mock.calls[0][0];
    expect(call.create).toMatchObject(LEAD_COLUMNS);
    expect(call.update).toMatchObject(LEAD_COLUMNS);
  });

  it.each([undefined, null])(
    'objetivo %s não escreve nada — o gravado é preservado',
    async (optimization) => {
      const { prisma, repository } = harness();

      await repository.upsertCampaign(campaignInput(optimization));
      await repository.upsertAdSet(adSetInput(optimization));

      for (const call of [
        prisma.campaign.upsert.mock.calls[0][0],
        prisma.adSet.upsert.mock.calls[0][0],
      ]) {
        for (const column of COLUMN_NAMES) {
          expect(call.update).not.toHaveProperty(column);
          expect(call.create).not.toHaveProperty(column);
        }
      }
    },
  );
});
