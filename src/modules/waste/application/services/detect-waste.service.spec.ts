import { DetectWasteService } from './detect-waste.service';
import {
  conversionTarget,
  nonConversionTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { DEFAULT_DETECTOR_PROFILE } from 'src/modules/waste/domain/detector-profile';
import { fingerprintOf } from 'src/modules/waste/domain/fingerprint';
import type {
  AdWasteDenormalization,
  OpenWasteItem,
  WasteItemWrite,
  WasteResolutionWrite,
} from 'src/modules/waste/domain/ports/waste-items.repository';
import type {
  DetectableAd,
  DetectionSettings,
} from 'src/modules/waste/domain/ports/waste-targets.repository';
import type { AdMetricSnapshotRow } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { createRootJobContext } from 'src/shared/domain/events/job-context';

/**
 * O ciclo de §10.7 contra dublês — **e o gate declarado do sprint**:
 *
 * > "Teste: integração fora do ar por uma noite ⇒ **zero** itens resolvidos."
 *
 * O teste é de serviço e não de domínio porque a guarda do passo 1 é sobre I/O:
 * ela lê a saúde da conta e decide **não fazer nada**. Uma função pura não teria
 * onde errar; o serviço tem, e é exatamente aqui que o v1 errava.
 */

const NOW = new Date('2026-07-15T06:00:00.000Z');
const AD_ACCOUNT = 'account-1';
const ORGANIZATION = 'org-1';

function settings(
  overrides: Partial<DetectionSettings> = {},
): DetectionSettings {
  return {
    organizationId: ORGANIZATION,
    accountId: 'acc-1',
    baseCurrency: 'BRL',
    windowDays: 14,
    attributionWindowDays: 7,
    activeDetectorProfileVersion: DEFAULT_DETECTOR_PROFILE.version,
    hasValidObservation: true,
    detectionAllowed: true,
    detectionBlockedReason: null,
    lastSuccessfulFullSyncAt: NOW,
    ...overrides,
  };
}

const ad: DetectableAd = {
  id: 'ad-1',
  accountId: 'acc-1',
  adSetId: 'set-1',
  campaignId: 'campaign-1',
  adAccountId: AD_ACCOUNT,
  platform: 'META',
  unitKind: 'AD',
  creativeId: 'creative-1',
  contentHash: null,
  isDelivering: true,
  optimization: conversionTarget('PURCHASE'),
  archivedAt: null,
  currency: 'BRL',
  dataMaturity: 'MATURE',
};

/**
 * Uma série que cobre **todos os recortes de maturidade**, não só o de hoje.
 *
 * Desde a correção de §8.9 cada classe julga uma janela que termina antes dos
 * dias em re-declaração: os achados que exigem `MATURE` olham D-28..D-14 numa
 * conta que atribui em 7 dias. Uma série de 14 dias terminando ontem deixaria
 * esse recorte vazio, e o teste passaria a medir a ausência de dado em vez do
 * detector.
 */
const MATURE_LAG_DAYS = 14;

function rows(requested: number, overrides: Partial<AdMetricSnapshotRow> = {}) {
  const days = requested + MATURE_LAG_DAYS;

  return Array.from({ length: days }, (_, index) => ({
    adId: ad.id,
    organizationId: ORGANIZATION,
    adAccountId: AD_ACCOUNT,
    campaignId: 'campaign-1',
    adSetId: 'set-1',
    creativeId: 'creative-1',
    platform: 'META' as const,
    date: new Date(NOW.getTime() - (days - index) * 24 * 60 * 60 * 1000),
    spend: 100,
    revenue: 0,
    currency: 'BRL',
    spendBase: 100,
    revenueBase: 0,
    baseCurrency: 'BRL',
    normalizationPending: false,
    impressions: 5_000,
    clicks: 50,
    conversions: 0,
    reach: null,
    frequency: null,
    videoViews: null,
    engagement: null,
    thumbstopRate: null,
    holdRate: null,
    hides: null,
    hideAllFor: null,
    reports: null,
    unlikes: null,
    seriesDiscontinuity: null,
    syncedAt: NOW,
    ...overrides,
  }));
}

const openItem: OpenWasteItem = {
  id: 'item-1',
  adId: ad.id,
  type: 'ZERO_CONVERSIONS',
  fingerprint: fingerprintOf(ad.id, 'ZERO_CONVERSIONS'),
  detectorVersion: 'v2.0.0',
  occurrences: 3,
  lastSeenAt: new Date('2026-07-14T06:00:00.000Z'),
  windowDays: 14,
  observed: { spendBase: 1_400, conversions: 0, revenueBase: 0 },
};

function build(input: {
  settings?: Partial<DetectionSettings>;
  ads?: DetectableAd[];
  metrics?: AdMetricSnapshotRow[];
  open?: OpenWasteItem[];
}) {
  const resolved: WasteResolutionWrite[] = [];
  const upserted: WasteItemWrite[] = [];
  const denormalized: AdWasteDenormalization[] = [];
  const staleCalls: Array<{ ids: string[]; stale: boolean }> = [];
  const emitted: Array<{ name: string; payload: unknown }> = [];

  const targets = {
    settingsForAccount: jest.fn().mockResolvedValue(settings(input.settings)),
    profileFor: jest.fn().mockResolvedValue(DEFAULT_DETECTOR_PROFILE),
    listDetectable: jest.fn().mockResolvedValue(input.ads ?? [ad]),
    listAccountsToDetect: jest.fn().mockResolvedValue([]),
  };

  const metrics = {
    query: jest.fn().mockResolvedValue(input.metrics ?? rows(14)),
    countActiveAds: jest.fn(),
  };

  const items = {
    openItemsFor: jest.fn().mockResolvedValue(input.open ?? []),
    upsertMany: jest.fn(async (writes: WasteItemWrite[]) => {
      upserted.push(...writes);
      return writes.map((write) => ({
        fingerprint: write.fingerprint,
        id: `persisted-${write.type}`,
        created: true,
      }));
    }),
    resolveMany: jest.fn(async (resolutions: WasteResolutionWrite[]) => {
      resolved.push(...resolutions);
      return resolutions.length;
    }),
    markStaleObservation: jest.fn(
      async (call: { ids: string[]; stale: boolean }) => {
        staleCalls.push(call);
        return call.ids.length;
      },
    ),
    denormalizeIntoAds: jest.fn(async (updates: AdWasteDenormalization[]) => {
      denormalized.push(...updates);
    }),
    resolveOne: jest.fn(),
  };

  const scores = {
    currentByAdIds: jest.fn().mockResolvedValue(new Map()),
    seriesByLineage: jest.fn(),
  };

  const events = {
    emitFrom: jest.fn((_ctx, name: string, payload: unknown) => {
      emitted.push({ name, payload });
      return { eventId: 'evt' };
    }),
  };

  const env = { get: jest.fn().mockReturnValue(true) };

  const service = new DetectWasteService(
    targets as never,
    metrics as never,
    items as never,
    scores as never,
    events as never,
    env as never,
  );

  return {
    service,
    items,
    metrics,
    resolved,
    upserted,
    denormalized,
    staleCalls,
    emitted,
  };
}

const run = (harness: ReturnType<typeof build>) =>
  harness.service.execute({
    adAccountId: AD_ACCOUNT,
    ctx: createRootJobContext(),
    now: NOW,
  });

describe('§10.7 passo 1 — sem observação válida, nada acontece', () => {
  it('integração fora do ar por uma noite resolve ZERO itens', async () => {
    const harness = build({
      settings: { hasValidObservation: false },
      open: [openItem],
    });

    const outcome = await run(harness);

    // O gate do sprint, em uma linha.
    expect(harness.resolved).toEqual([]);
    expect(harness.items.resolveMany).not.toHaveBeenCalled();
    expect(outcome.blockedReason).toBe('NO_VALID_OBSERVATION');
  });

  it('os itens abertos ficam abertos e se declaram velhos', async () => {
    const harness = build({
      settings: { hasValidObservation: false },
      open: [openItem],
    });

    await run(harness);

    // Não resolver não basta: a tela precisa distinguir "isto ainda é verdade"
    // de "isto é o que sabíamos antes de a leitura falhar".
    expect(harness.staleCalls).toEqual([{ ids: ['item-1'], stale: true }]);
  });

  it('não lê a série nem grava denormalização', async () => {
    const harness = build({
      settings: { hasValidObservation: false },
      open: [openItem],
    });

    await run(harness);

    expect(harness.metrics.query).not.toHaveBeenCalled();
    expect(harness.items.denormalizeIntoAds).not.toHaveBeenCalled();
  });

  it('conta degradada (§8.7) também não resolve nada', async () => {
    const harness = build({
      settings: {
        detectionAllowed: false,
        detectionBlockedReason: 'ACCOUNT_DEGRADED',
      },
      open: [openItem],
    });

    const outcome = await run(harness);

    expect(outcome.blockedReason).toBe('ACCOUNT_DEGRADED');
    expect(harness.resolved).toEqual([]);
  });
});

describe('§10.7 passos 6 a 9 — o caminho feliz', () => {
  it('grava o achado com as duas grandezas e a versão do perfil aplicado', async () => {
    const harness = build({});

    const outcome = await run(harness);

    expect(outcome.findings).toBeGreaterThan(0);
    const write = harness.upserted.find(
      (candidate) => candidate.type === 'ZERO_CONVERSIONS',
    );

    expect(write).toBeDefined();
    expect(write?.incurredAmountBase).toBe(1_400);
    expect(write?.avoidableDailyBase).toBe(100);
    expect(write?.detectorProfileVersion).toBe(
      DEFAULT_DETECTOR_PROFILE.version,
    );
    expect(write?.windowDays).toBe(14);
  });

  it('denormaliza TODO anúncio avaliado, inclusive os sem achado', async () => {
    const clean = { ...ad, id: 'ad-clean' };
    const harness = build({ ads: [ad, clean] });

    await run(harness);

    const cleanRow = harness.denormalized.find(
      (row) => row.adId === 'ad-clean',
    );

    // Sem esta linha, um anúncio que deixou de ter desperdício continuaria
    // exibindo o número da última vez que teve.
    expect(cleanRow).toMatchObject({
      openWasteCount: 0,
      openWasteAmountBase: 0,
      avoidableDailyAmountBase: 0,
    });
  });

  it('emite waste.detected com as duas grandezas nas duas moedas', async () => {
    const harness = build({});

    await run(harness);

    const event = harness.emitted.find(
      (item) => item.name === 'waste.detected',
    );

    expect(event?.payload).toMatchObject({
      adId: 'ad-1',
      kind: 'WASTE',
      incurred: { currency: 'BRL', baseCurrency: 'BRL' },
      avoidableDaily: { currency: 'BRL', baseCurrency: 'BRL' },
    });
  });

  it('achado que cessou resolve como RESOLVED_EXTERNALLY e emite', async () => {
    // A série passa a converter **com gasto maior**: o anúncio continuou
    // rodando e passou a funcionar. Isso é acerto do detector, não re-declaração.
    const harness = build({
      open: [openItem],
      metrics: rows(14, { conversions: 3, revenueBase: 500, spendBase: 200 }),
    });

    await run(harness);

    expect(harness.resolved).toEqual([
      expect.objectContaining({
        id: 'item-1',
        kind: 'RESOLVED_EXTERNALLY',
      }),
    ]);
    expect(
      harness.emitted.some((event) => event.name === 'waste.resolved'),
    ).toBe(true);
  });

  it('o mesmo achado com o passado reescrito resolve como falso positivo', async () => {
    // Gasto parado, conversão aparecendo: a plataforma atribuiu retroativamente.
    const harness = build({
      open: [openItem],
      metrics: rows(14, { conversions: 1, revenueBase: 300 }),
    });

    await run(harness);

    expect(harness.resolved[0].kind).toBe('RESOLVED_BY_RESTATEMENT');
  });

  it('mudança de LÓGICA supersede antes do upsert; limiar não supersede', async () => {
    const harness = build({
      open: [{ ...openItem, detectorVersion: 'v1.0.0' }],
    });

    await run(harness);

    expect(harness.resolved).toEqual([
      expect.objectContaining({ kind: 'SUPERSEDED_BY_DETECTOR' }),
    ]);
    // E o achado volta a ser gravado na versão nova, no mesmo ciclo: o índice
    // parcial admite um aberto por fingerprint, e é por isso que a supersessão
    // roda antes.
    expect(
      harness.upserted.some((write) => write.type === 'ZERO_CONVERSIONS'),
    ).toBe(true);
  });
});

describe('objetivo de otimização e silêncio explicado', () => {
  it('anúncio de alcance não recebe achado de conversão, e o motivo fica gravado', async () => {
    const awareness = { ...ad, optimization: nonConversionTarget('AWARENESS') };
    const harness = build({ ads: [awareness] });

    const outcome = await run(harness);

    expect(
      harness.upserted.some((write) => write.type === 'ZERO_CONVERSIONS'),
    ).toBe(false);
    expect(outcome.notApplicable).toBeGreaterThan(0);

    const gaps = harness.denormalized[0].evidenceGaps ?? [];
    const objective = gaps.find(
      (gap) => gap.code === 'OBJECTIVE_NOT_CONVERSION',
    );
    expect(objective?.nature).toBe('NOT_APPLICABLE');
    expect(objective?.detectorTypes).toEqual(
      expect.arrayContaining(['ZERO_CONVERSIONS', 'HIGH_CPA', 'LOW_ROAS']),
    );
  });

  it('CPA de lead não entra na mediana de CPA de compra', async () => {
    // Três anúncios de lead baratos (CPA 10) e um de compra (CPA 50), cada um
    // no próprio conjunto: sem pares, a régua é a linha de base da conta. Numa
    // linha de base única, a mediana 10 faria o anúncio de compra "custar 5×" e
    // disparar HIGH_CPA — comparando custo por compra com custo por lead.
    const leadAds = [1, 2, 3].map((index) => ({
      ...ad,
      id: `lead-${index}`,
      adSetId: `set-lead-${index}`,
      optimization: conversionTarget('LEAD'),
    }));
    const purchaseAd = { ...ad, id: 'purchase-1', adSetId: 'set-purchase' };

    const harness = build({
      ads: [...leadAds, purchaseAd],
      metrics: [
        ...leadAds.flatMap((lead) =>
          rows(14, { adId: lead.id, adSetId: lead.adSetId, conversions: 10 }),
        ),
        ...rows(14, {
          adId: purchaseAd.id,
          adSetId: purchaseAd.adSetId,
          conversions: 2,
          revenueBase: 400,
        }),
      ],
    });

    await run(harness);

    expect(
      harness.upserted.some(
        (write) => write.adId === purchaseAd.id && write.type === 'HIGH_CPA',
      ),
    ).toBe(false);

    const gaps =
      harness.denormalized.find((row) => row.adId === purchaseAd.id)
        ?.evidenceGaps ?? [];
    expect(
      gaps.find((gap) => gap.code === 'NO_BENCHMARK')?.detectorTypes,
    ).toEqual(expect.arrayContaining(['HIGH_CPA']));
  });

  it('anúncio pausado não grava lacunas — não há o que esperar de quem não entrega', async () => {
    const paused = { ...ad, isDelivering: false };
    const harness = build({ ads: [paused] });

    await run(harness);

    expect(harness.denormalized[0].evidenceGaps).toBeNull();
  });
});

describe('grupo de recursos do Performance Max (D23)', () => {
  const assetGroup = (index: number, campaignId = 'campaign-pmax') => ({
    ...ad,
    id: `group-${index}`,
    platform: 'GOOGLE' as const,
    adSetId: null,
    campaignId,
    unitKind: 'ASSET_GROUP' as const,
  });

  const seriesOf = (
    unit: DetectableAd,
    overrides: Partial<AdMetricSnapshotRow> = {},
  ) =>
    rows(14, {
      adId: unit.id,
      adSetId: null,
      campaignId: unit.campaignId,
      platform: 'GOOGLE',
      ...overrides,
    });

  it('o CPA do grupo não entra na régua dos anúncios, nem o contrário', async () => {
    // Três anúncios de busca baratos (CPA 10) em conjuntos próprios, e um grupo
    // de recursos com CPA 50 sozinho na campanha. Com régua única, o grupo
    // "custaria 5×" a mediana e dispararia HIGH_CPA contra anúncios de outro
    // formato de entrega.
    const searchAds = [1, 2, 3].map((index) => ({
      ...ad,
      id: `search-${index}`,
      platform: 'GOOGLE' as const,
      adSetId: `set-search-${index}`,
    }));
    const group = assetGroup(1);

    const harness = build({
      ads: [...searchAds, group],
      metrics: [
        ...searchAds.flatMap((search) =>
          rows(14, {
            adId: search.id,
            adSetId: search.adSetId,
            platform: 'GOOGLE',
            conversions: 10,
          }),
        ),
        ...seriesOf(group, { conversions: 2, revenueBase: 400 }),
      ],
    });

    await run(harness);

    expect(
      harness.upserted.some(
        (write) => write.adId === group.id && write.type === 'HIGH_CPA',
      ),
    ).toBe(false);
    const gaps =
      harness.denormalized.find((row) => row.adId === group.id)?.evidenceGaps ??
      [];
    expect(
      gaps.find((gap) => gap.code === 'NO_BENCHMARK')?.detectorTypes,
    ).toEqual(expect.arrayContaining(['HIGH_CPA']));
  });
});
