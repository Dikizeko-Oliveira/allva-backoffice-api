import {
  ReportBuilderService,
  clampPeriodDays,
  DEFAULT_PERIOD_DAYS,
  MAX_PERIOD_DAYS,
  MIN_PERIOD_DAYS,
} from './report-builder.service';
import { AnalyticsAggregatorService } from 'src/modules/analytics/application/services/analytics-aggregator.service';
import { ReportDocument } from 'src/modules/reports/infrastructure/pdf/pdf-renderer.service';

/**
 * Nenhuma string de um `ReportDocument` pode conter o rastro de um valor mal
 * formatado. `NaN`/`undefined`/`null` cru é o defeito que os formatters em
 * `shared/domain/formatters.ts` existem para impedir — este teste anda pelo
 * documento inteiro (títulos, seções, tabelas) em vez de só olhar um campo,
 * porque um vazamento pode aparecer em qualquer célula.
 */
function collectStrings(doc: ReportDocument): string[] {
  const out: string[] = [doc.title];
  if (doc.subtitle) out.push(doc.subtitle);

  for (const section of doc.sections) {
    out.push(section.heading);
    out.push(...(section.paragraphs ?? []));
    out.push(...(section.bullets ?? []));
    if (section.table) {
      out.push(...section.table.columns);
      for (const row of section.table.rows) out.push(...row);
    }
  }

  return out;
}

function assertNoLeakedGarbage(doc: ReportDocument) {
  const bad = /\b(NaN|undefined|null)\b/;
  for (const text of collectStrings(doc)) {
    expect(text).not.toMatch(bad);
    expect(text).not.toContain('${');
  }
}

function buildService(overrides: {
  metricsQuery?: jest.Mock;
  historyFloorFor?: jest.Mock;
  wasteSummary?: jest.Mock;
  wasteRollup?: jest.Mock;
}) {
  const ads = {
    list: jest.fn().mockResolvedValue({ items: [], excludedByFloor: 0 }),
  };
  const waste = {
    summary:
      overrides.wasteSummary ??
      jest.fn().mockResolvedValue({
        openCount: 0,
        affectedAds: 0,
        incurred: null,
        avoidableDaily: null,
        byPriority: {},
        byType: {},
        asOf: null,
        excludedByWindowMismatch: 0,
      }),
    rollup:
      overrides.wasteRollup ??
      jest.fn().mockResolvedValue({
        rows: [],
        baseCurrency: null,
        excludedByWindowMismatch: 0,
      }),
  };
  const recommendations = {
    impactSummary: jest.fn().mockResolvedValue({
      byType: [],
      baseCurrency: 'BRL',
      measurement: {
        measured: 0,
        pending: 0,
        abandoned: 0,
        withConfounders: 0,
        versions: [],
      },
      advisoryExcluded: 0,
    }),
  };
  const settings = {
    forOrganization: jest.fn().mockResolvedValue({
      organizationId: 'org-1',
      windowDays: 14,
      detectorProfileVersion: 'v1',
      baseCurrency: 'BRL',
      recomputingCurrency: false,
    }),
  };
  const metrics = {
    query: overrides.metricsQuery ?? jest.fn().mockResolvedValue([]),
  };
  const aggregator = new AnalyticsAggregatorService();
  const planEntitlement = {
    historyFloorFor:
      overrides.historyFloorFor ?? jest.fn().mockResolvedValue(null),
  };

  return new ReportBuilderService(
    ads as any,
    waste as any,
    recommendations as any,
    settings as any,
    metrics as any,
    aggregator,
    planEntitlement as any,
  );
}

describe('clampPeriodDays', () => {
  it('keeps a value already inside the range', () => {
    expect(clampPeriodDays(90)).toBe(90);
  });

  it('clamps below the floor and above the ceiling', () => {
    expect(clampPeriodDays(1)).toBe(MIN_PERIOD_DAYS);
    expect(clampPeriodDays(10_000)).toBe(MAX_PERIOD_DAYS);
  });

  it('falls back to the default for a non-finite input', () => {
    expect(clampPeriodDays(NaN)).toBe(DEFAULT_PERIOD_DAYS);
    expect(clampPeriodDays(Infinity)).toBe(DEFAULT_PERIOD_DAYS);
  });

  it('rounds a fractional value', () => {
    expect(clampPeriodDays(30.6)).toBe(31);
  });
});

describe('ReportBuilderService — edge cases sem vazamento de NaN/undefined/null', () => {
  it('period-performance com zero linhas de métrica', async () => {
    const service = buildService({});

    const doc = await service.build(
      'period-performance',
      { accountId: 'acc-1', organizationId: 'org-1' },
      { periodDays: 30 },
    );

    assertNoLeakedGarbage(doc);
  });

  it('period-performance truncado pelo piso de histórico do plano', async () => {
    const floor = new Date('2026-08-01T00:00:00.000Z');
    const service = buildService({
      historyFloorFor: jest.fn().mockResolvedValue(floor),
    });

    const doc = await service.build(
      'period-performance',
      { accountId: 'acc-1', organizationId: 'org-1' },
      { periodDays: 365 },
    );

    assertNoLeakedGarbage(doc);
    const provenance = doc.sections[0];
    expect(provenance.bullets?.some((b) => b.includes('truncado'))).toBe(true);
  });

  it('waste-report com summary e rollup zerados/nulos', async () => {
    const service = buildService({
      wasteRollup: jest.fn().mockResolvedValue({
        rows: [
          {
            groupId: 'c1',
            groupName: 'Campanha 1',
            affectedAds: 0,
            openWasteBase: 0,
            avoidableDailyBase: 0,
            criticalItems: 0,
          },
        ],
        baseCurrency: null,
        excludedByWindowMismatch: 0,
      }),
    });

    const doc = await service.build('waste-report', {
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    assertNoLeakedGarbage(doc);
  });

  it('executive-summary sem impacto medido', async () => {
    const service = buildService({});

    const doc = await service.build('executive-summary', {
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    assertNoLeakedGarbage(doc);
  });

  it('recusa gerar sem organização', async () => {
    const service = buildService({});

    await expect(
      service.build('weekly-performance', { accountId: 'acc-1' }),
    ).rejects.toThrow();
  });
});
