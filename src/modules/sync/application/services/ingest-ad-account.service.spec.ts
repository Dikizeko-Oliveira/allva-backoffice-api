import { IngestAdAccountService } from './ingest-ad-account.service';
import { MetricsIngestService } from './metrics-ingest.service';
import { PlatformBudgetService } from './platform-budget.service';
import { StructureIngestService } from './structure-ingest.service';
import {
  AdStructureRepositoryInterface,
  AdSyncSnapshot,
  UpsertAdInput,
  UpsertedAd,
} from '../../domain/ports/ad-structure.repository';
import {
  AdMetricUpsert,
  AdMetricsIngestRepositoryInterface,
  IngestedMetricsSummary,
} from '../../domain/ports/ad-metrics-ingest.repository';
import {
  AdAccountsSyncRepositoryInterface,
  SyncableAdAccount,
} from '../../domain/ports/ad-accounts-sync.repository';
import { SyncQuarantineRepositoryInterface } from '../../domain/ports/sync-quarantine.repository';
import { SyncOperationsRepositoryInterface } from '../../domain/ports/sync-operations.repository';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import type { ProviderSyncResult } from 'src/modules/integrations/domain/ports';
import type { DataMaturity } from '../../domain/data-maturity';

const NOW = new Date('2026-08-01T12:00:00Z');
const ACCOUNT: SyncableAdAccount = {
  id: 'acc-1',
  accountId: 'user-1',
  organizationId: 'org-1',
  platform: 'META',
  externalAccountId: 'act_999',
  name: 'Conta principal',
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

// ─── fakes ────────────────────────────────────────────────────────────────────

class FakeAccounts extends AdAccountsSyncRepositoryInterface {
  account: SyncableAdAccount = { ...ACCOUNT };
  health: unknown[] = [];

  async findById() {
    return this.account;
  }
  async listSyncable() {
    return [this.account];
  }
  async listByIntegration() {
    return [this.account];
  }
  async upsertDiscovered() {
    return { id: this.account.id, created: false, rebound: false };
  }
  async updateHealth(_id: string, update: unknown) {
    this.health.push(update);
    const next = update as { health: SyncableAdAccount['syncHealth'] };
    this.account = { ...this.account, syncHealth: next.health };
  }
  async updateRestatementWindow() {}
  async detachIntegration() {}
}

class FakeStructure extends AdStructureRepositoryInterface {
  ads = new Map<string, AdSyncSnapshot>();
  archived: string[] = [];
  maturity = new Map<string, DataMaturity | null>();
  private seq = 0;

  async upsertCampaign() {
    return 'camp-1';
  }
  async upsertAdSet() {
    return 'set-1';
  }
  async upsertCreative() {
    return 'creative-1';
  }

  async upsertAd(input: UpsertAdInput): Promise<UpsertedAd> {
    const existing = [...this.ads.values()].find(
      (ad) => ad.externalAdId === input.externalAdId,
    );

    if (existing) {
      if (input.writeObservedStatus) {
        existing.observedStatus = input.observedStatus;
        existing.observedAsOf = input.observedAsOf;
      }
      existing.archivedAt = null;
      existing.lastStructureSyncAt = input.lastStructureSyncAt;
      return { id: existing.id, lineageId: existing.lineageId };
    }

    const id = `ad-${++this.seq}`;
    this.ads.set(id, {
      id,
      organizationId: input.organizationId,
      adAccountId: input.adAccountId,
      externalAdId: input.externalAdId,
      lineageId: id,
      observedStatus: input.observedStatus,
      observedAsOf: input.observedAsOf,
      desiredStatus: null,
      desiredStatusSetAt: null,
      syncState: 'IN_SYNC',
      driftDetails: null,
      lastMetricsSyncAt: null,
      lastStructureSyncAt: input.lastStructureSyncAt,
      archivedAt: null,
    });

    return { id, lineageId: id };
  }

  async mapCampaignIds() {
    return new Map([['c-1', 'camp-1']]);
  }
  async mapAdSetIds() {
    return new Map([['s-1', 'set-1']]);
  }
  async mapCreativeIds() {
    return new Map([['cr-1', 'creative-1']]);
  }
  async listAdsOfAccount() {
    return [...this.ads.values()];
  }
  async findAdsByExternalIds(_accountId: string, externalAdIds: string[]) {
    return [...this.ads.values()].filter((ad) =>
      externalAdIds.includes(ad.externalAdId),
    );
  }
  async findAdsByIds(_organizationId: string, adIds: string[]) {
    return [...this.ads.values()].filter((ad) => adIds.includes(ad.id));
  }
  async listForReconciliation() {
    return [...this.ads.values()];
  }

  async archiveAdsNotSeen(input: {
    seenExternalAdIds: string[];
    archivedAt: Date;
  }) {
    const stale = [...this.ads.values()].filter(
      (ad) =>
        !ad.archivedAt && !input.seenExternalAdIds.includes(ad.externalAdId),
    );
    for (const ad of stale) {
      ad.archivedAt = input.archivedAt;
      this.archived.push(ad.id);
    }
    return stale;
  }

  async updateDataMaturity(
    updates: Array<{ adId: string; dataMaturity: DataMaturity | null }>,
  ) {
    for (const update of updates) {
      this.maturity.set(update.adId, update.dataMaturity);
    }
  }
  async applySyncState() {}
  async touchMetricsSync() {}
}

class FakeMetrics extends AdMetricsIngestRepositoryInterface {
  /** `adId|date` → linha, exatamente como a unique de `(adId, date, granularity)`. */
  rows = new Map<string, AdMetricUpsert>();

  async upsertMany(rows: AdMetricUpsert[]): Promise<IngestedMetricsSummary> {
    const latestDateByAd = new Map<string, Date>();

    for (const row of rows) {
      this.rows.set(`${row.adId}|${row.date.toISOString().slice(0, 10)}`, row);
      const latest = latestDateByAd.get(row.adId);
      if (!latest || row.date > latest) latestDateByAd.set(row.adId, row.date);
    }

    return {
      rows: rows.length,
      pendingNormalization: rows.filter((row) => row.normalizationPending)
        .length,
      latestDateByAd,
    };
  }

  async latestDateByAd() {
    return new Map<string, Date>();
  }
}

class FakeQuarantine extends SyncQuarantineRepositoryInterface {
  recorded: Array<{ externalAdId: string; reason: string }> = [];
  open: Array<{ id: string; externalAdId: string; attempts: number }> = [];
  resolved: Array<{ ids: string[]; resolution: string }> = [];

  async record(input: { externalAdId: string; reason: string }) {
    this.recorded.push({
      externalAdId: input.externalAdId,
      reason: input.reason,
    });
  }
  async listOpen() {
    return this.open.map((item) => ({
      ...item,
      organizationId: 'org-1',
      adAccountId: 'acc-1',
      reason: 'CAMPAIGN_NOT_RESOLVED',
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      payload: null,
    }));
  }
  async resolve(input: { ids: string[]; resolution: string }) {
    if (input.ids.length > 0) this.resolved.push(input);
    return input.ids.length;
  }
  async list() {
    return { items: [], nextCursor: null };
  }
}

class FakeOperations extends SyncOperationsRepositoryInterface {
  closed: Array<Record<string, unknown>> = [];

  async open() {
    return { id: 'op-1', startedAt: NOW };
  }
  async saveCheckpoint() {}
  async close(_id: string, input: Record<string, unknown>) {
    this.closed.push(input);
  }
  async lastCheckpoint() {
    return null;
  }
}

// ─── harness ──────────────────────────────────────────────────────────────────

function buildIngest(providerResult: ProviderSyncResult) {
  const accounts = new FakeAccounts();
  const structure = new FakeStructure();
  const metrics = new FakeMetrics();
  const quarantine = new FakeQuarantine();
  const operations = new FakeOperations();
  const emitted: Array<{ name: string; payload: unknown }> = [];

  const events = {
    emitFrom: (_ctx: unknown, name: string, payload: unknown) => {
      emitted.push({ name, payload });
      return { eventId: 'evt', name } as never;
    },
  };

  // Taxa 1:1 — a normalização monetária tem testes próprios em `currency`; o
  // que interessa aqui é que a linha entra com moeda dupla e sem bloquear.
  const currency = {
    tableFor: async () => ({
      normalize: (amount: number) => ({
        valueBase: amount,
        fxRate: 1,
        fxAsOf: NOW,
        fxSource: 'test',
        normalizationPending: false,
      }),
    }),
  };

  const provider = { syncAdAccountMetrics: async () => providerResult };

  const service = new IngestAdAccountService(
    accounts,
    structure,
    operations,
    { findById: async () => integrationStub() } as never,
    { for: () => provider } as never,
    { executeForIntegration: async () => integrationStub() } as never,
    { record: async () => undefined } as never,
    // Sem origem de linhagem: o caso comum é o anúncio que o usuário criou no
    // gerenciador, e esse começa a própria.
    new StructureIngestService(structure, quarantine, {
      findOriginFor: async () => new Map(),
    } as never),
    new MetricsIngestService(metrics, structure, currency as never),
    new PlatformBudgetService({
      tryAcquire: () => ({ allowed: true, retryAfterMs: 0 }),
    } as never),
    events as never,
    // A contabilidade de R4: o ciclo reporta o que gastou (A2-S9, entrega 9).
    { accountingFor: () => ({ granted: 11, denied: 0 }) } as never,
    {
      get: (key: string) => (key === 'ADS_SYNC_LOOKBACK_DAYS' ? 14 : 0),
    } as never,
  );

  return {
    service,
    accounts,
    structure,
    metrics,
    quarantine,
    operations,
    emitted,
  };
}

function integrationStub() {
  return {
    id: 'int-1',
    providerType: 'META',
    organizationId: 'org-1',
    accountId: 'user-1',
    expiresAt: new Date('2027-01-01T00:00:00Z'),
  } as never;
}

function providerAd(externalAdId: string, status = 'ACTIVE') {
  return {
    externalAdId,
    adSetExternalId: 's-1',
    campaignExternalId: 'c-1',
    creativeExternalId: 'cr-1',
    name: `Anúncio ${externalAdId}`,
    status,
    updatedAt: new Date('2026-08-01T11:00:00Z'),
  };
}

function metricRow(adExternalId: string, date: string, overrides = {}) {
  return {
    date: new Date(date),
    level: 'AD' as const,
    externalEntityId: adExternalId,
    campaignExternalId: 'c-1',
    adSetExternalId: 's-1',
    adExternalId,
    creativeExternalId: 'cr-1',
    spend: 100,
    impressions: 1000,
    clicks: 10,
    conversions: 0,
    revenue: 0,
    ...overrides,
  };
}

const BASE_RESULT: ProviderSyncResult = {
  metrics: [],
  campaigns: [{ externalCampaignId: 'c-1', name: 'Campanha' }],
  adSets: [
    { externalAdSetId: 's-1', campaignExternalId: 'c-1', name: 'Conjunto' },
  ],
  ads: [],
  creatives: [{ externalCreativeId: 'cr-1' }],
  wasComplete: true,
};

// ─── testes ───────────────────────────────────────────────────────────────────

describe('① ingest — a guarda de arquivamento em operação (§8.2)', () => {
  it('arquiva o que não veio quando a leitura foi completa', async () => {
    const h = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1'), providerAd('ext-2')],
    });
    const ctx = createRootJobContext();

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    // Segunda passagem: `ext-2` sumiu da plataforma.
    const second = buildIngest({ ...BASE_RESULT, ads: [providerAd('ext-1')] });
    second.structure.ads = h.structure.ads;

    const outcome = await second.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    expect(outcome.archived).toBe(1);
    expect(second.emitted.map((event) => event.name)).toContain('ad.archived');
  });

  it('**resposta truncada ⇒ 0 arquivados e conta UNREACHABLE**', async () => {
    // O gate central do sprint. Sem ele, uma reconexão com escopo menor arquiva
    // milhares de anúncios ativos e zera o número de capa do usuário.
    const h = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1'), providerAd('ext-2')],
    });
    const ctx = createRootJobContext();

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    const truncated = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1')],
      wasComplete: false,
      stepFailures: [
        { step: 'ADS', message: 'permissão revogada', status: 403 },
      ],
    });
    truncated.structure.ads = h.structure.ads;

    const outcome = await truncated.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    expect(outcome.archived).toBe(0);
    expect(truncated.structure.archived).toEqual([]);
    expect(outcome.health).toBe('UNREACHABLE');
    expect(outcome.archiveSuppressedReason).toContain('não cobriu');
  });

  it('a supressão é declarada — nunca silenciosa', async () => {
    const h = buildIngest({ ...BASE_RESULT, wasComplete: false });

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx: createRootJobContext(),
      now: NOW,
      forceFullScan: true,
    });

    expect(h.emitted.map((event) => event.name)).toContain(
      'sync.archive_suppressed',
    );
    expect(h.operations.closed[0]).toMatchObject({
      wasComplete: false,
      status: 'PARTIAL',
    });
  });

  it('varredura incremental nunca arquiva — updated_since não reporta remoção', async () => {
    const h = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1'), providerAd('ext-2')],
    });
    const ctx = createRootJobContext();

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    const incremental = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1')],
    });
    incremental.structure.ads = h.structure.ads;

    const outcome = await incremental.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: false,
    });

    expect(outcome.archived).toBe(0);
  });
});

describe('① ingest — janela de re-declaração e maturidade (§8.9)', () => {
  it('conversão que chega em D+9 atualiza o snapshot de D', async () => {
    const ctx = createRootJobContext();
    const day = '2026-07-23';

    const first = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1')],
      metrics: [metricRow('ext-1', day, { conversions: 0, revenue: 0 })],
    });

    await first.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    expect(first.metrics.rows.get(`ad-1|${day}`)).toMatchObject({
      conversions: 0,
    });

    // Nove dias depois, a plataforma re-declara o mesmo dia com a conversão.
    const restated = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1')],
      metrics: [metricRow('ext-1', day, { conversions: 3, revenue: 450 })],
    });
    restated.structure.ads = first.structure.ads;
    restated.metrics.rows = first.metrics.rows;

    await restated.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    // Mesma chave `(adId, date)`: a linha foi **reescrita**, não duplicada.
    expect(restated.metrics.rows.size).toBe(1);
    expect(restated.metrics.rows.get(`ad-1|${day}`)).toMatchObject({
      conversions: 3,
      revenue: 450,
      revenueBase: 450,
    });
  });

  it('denormaliza a maturidade do dia mais novo da série', async () => {
    const h = buildIngest({
      ...BASE_RESULT,
      ads: [providerAd('ext-1')],
      metrics: [
        metricRow('ext-1', '2026-07-01'),
        metricRow('ext-1', '2026-07-31'),
      ],
    });

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx: createRootJobContext(),
      now: NOW,
      forceFullScan: true,
    });

    // 31/07 tem 1 dia contra janela de atribuição de 7: ainda vai mudar.
    expect(h.structure.maturity.get('ad-1')).toBe('IMMATURE');
  });
});

describe('① ingest — quarentena e identidade (P10)', () => {
  it('anúncio sem campanha resolvível vai para quarentena, sem abortar o resto', async () => {
    const h = buildIngest({
      ...BASE_RESULT,
      ads: [
        providerAd('ext-1'),
        { ...providerAd('ext-orfao'), campaignExternalId: 'c-desconhecida' },
      ],
    });

    const outcome = await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx: createRootJobContext(),
      now: NOW,
      forceFullScan: true,
    });

    expect(outcome.quarantined).toBe(1);
    expect(outcome.adsUpserted).toBe(1);
    expect(h.quarantine.recorded[0]).toMatchObject({
      externalAdId: 'ext-orfao',
      reason: 'CAMPAIGN_NOT_RESOLVED',
    });
  });

  it('o item em quarentena entra no domínio assim que o pai aparece', async () => {
    const h = buildIngest({ ...BASE_RESULT, ads: [providerAd('ext-antes')] });
    h.quarantine.open = [{ id: 'q-1', externalAdId: 'ext-antes', attempts: 3 }];

    await h.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx: createRootJobContext(),
      now: NOW,
      forceFullScan: true,
    });

    expect(h.quarantine.resolved).toEqual([
      { ids: ['q-1'], resolution: 'PARENT_APPEARED', at: NOW },
    ]);
  });

  it('reingerir a mesma conta preserva id e linhagem do anúncio (P10)', async () => {
    const ctx = createRootJobContext();
    const first = buildIngest({ ...BASE_RESULT, ads: [providerAd('ext-1')] });

    await first.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    const before = [...first.structure.ads.values()][0];

    const second = buildIngest({ ...BASE_RESULT, ads: [providerAd('ext-1')] });
    second.structure.ads = first.structure.ads;

    await second.service.execute({
      adAccountId: 'acc-1',
      trigger: 'SCHEDULE',
      ctx,
      now: NOW,
      forceFullScan: true,
    });

    const after = [...second.structure.ads.values()][0];

    expect(after.id).toBe(before.id);
    expect(after.lineageId).toBe(before.lineageId);
    expect(second.structure.ads.size).toBe(1);
  });
});
