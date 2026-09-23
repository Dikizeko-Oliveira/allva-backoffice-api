import {
  GetWasteItemUseCase,
  GetWasteRollupUseCase,
  GetWasteSummaryUseCase,
  ListWasteByAdUseCase,
  ListWasteItemsUseCase,
} from './waste-read-use-cases';
import { DETECTOR_SUITE_VERSION } from 'src/modules/waste/domain/detectors';
import type {
  WasteItemView,
  WasteReadRepositoryInterface,
} from 'src/modules/waste/domain/ports/waste-read.repository';
import type { EnvService } from 'src/shared/infrastructure/config/env.service';
import { encodeCursor } from 'src/shared/infrastructure/http/pagination/cursor';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * Plano que libera tudo.
 *
 * Os casos deste arquivo são de leitura e cursor: o corte por plano tem
 * descrição própria mais abaixo, e deixá-lo ligado aqui faria todo teste de
 * paginação depender de uma decisão comercial que ele não está exercendo.
 */
function allowingPlans() {
  return {
    stateFor: jest.fn().mockResolvedValue({ allowed: true }),
  } as never;
}

/**
 * A superfície de leitura contra o contrato de §7.0 e P7.
 *
 * O que estes testes cobram não é o número — é **a procedência do número**.
 * Toda rota de inteligência responde com `asOf` e `provenance`, e o
 * `ResponseEnvelopeInterceptor` falha fora de produção quando não responde. Aqui
 * a verificação é direta: a janela declarada é a ativa da organização, a versão
 * do detector e a do perfil viajam junto, e o rótulo `PARTIAL` aparece quando —
 * e só quando — algum item da página se apoia em evidência degradada.
 */

const SETTINGS = {
  organizationId: 'org-1',
  windowDays: 14,
  detectorProfileVersion: 'waste-thresholds-v1',
  baseCurrency: 'BRL',
  recomputingCurrency: false,
};

function itemView(overrides: Partial<WasteItemView> = {}): WasteItemView {
  return {
    id: 'item-1',
    ad: {
      id: 'ad-1',
      lineageId: 'ad-1',
      name: 'Anúncio',
      platform: 'META',
      externalAdId: 'ext-1',
      observedStatus: 'ACTIVE',
      campaign: { id: 'campaign-1', name: 'Campanha' },
      adSet: null,
    },
    type: 'ZERO_CONVERSIONS',
    findingKind: 'WASTE',
    priority: 'CRITICAL',
    windowDays: 14,
    incurred: {
      value: 1_400,
      currency: 'BRL',
      valueBase: 1_400,
      baseCurrency: 'BRL',
    },
    avoidableDaily: {
      value: 100,
      currency: 'BRL',
      valueBase: 100,
      baseCurrency: 'BRL',
    },
    diagnosis: '14 dias, 1400 gastos, nenhuma conversão.',
    evidence: {},
    evidenceSufficiency: 'SUFFICIENT',
    scopeLevel: 'AD',
    dataMaturity: 'MATURE',
    detectorVersion: 'v2.0.0',
    detectorProfileVersion: 'waste-thresholds-v1',
    occurrences: 3,
    detectedAt: new Date('2026-07-20T06:00:00.000Z'),
    lastSeenAt: new Date('2026-08-02T06:00:00.000Z'),
    staleObservation: false,
    resolvedAt: null,
    resolutionKind: null,
    ...overrides,
  };
}

function build(overrides: Partial<WasteReadRepositoryInterface> = {}) {
  const read = {
    list: jest.fn().mockResolvedValue({ items: [itemView()], hasMore: false }),
    findOne: jest.fn().mockResolvedValue(itemView()),
    openForAd: jest.fn().mockResolvedValue([]),
    summary: jest.fn().mockResolvedValue({
      openCount: 3,
      affectedAds: 1,
      incurred: null,
      avoidableDaily: null,
      byPriority: { LOW: 0, MEDIUM: 0, HIGH: 1, CRITICAL: 2 },
      byType: {},
      asOf: new Date('2026-08-02T06:00:00.000Z'),
      excludedByWindowMismatch: 4,
    }),
    rollup: jest.fn().mockResolvedValue({
      rows: [],
      baseCurrency: 'BRL',
      excludedByWindowMismatch: 0,
    }),
    byAd: jest.fn().mockResolvedValue({ rows: [], hasMore: false }),
    findDenormalizationDrift: jest.fn(),
    ...overrides,
  };

  const settings = { forOrganization: jest.fn().mockResolvedValue(SETTINGS) };
  const env = { get: jest.fn().mockReturnValue(true) } as unknown as EnvService;

  return { read, settings, env };
}

describe('a flag desliga a superfície inteira, com erro tipado', () => {
  it('recusa com PRECONDITION_FAILED quando o detector está desligado', async () => {
    const h = build();
    const off = {
      get: jest.fn().mockReturnValue(false),
    } as unknown as EnvService;

    const useCase = new GetWasteSummaryUseCase(
      h.read as never,
      h.settings as never,
      off,
    );

    // Erro tipado, não 500: "está desligado" é uma resposta, e o cliente precisa
    // distinguir isso de "quebrou".
    await expect(useCase.execute('org-1', {})).rejects.toBeInstanceOf(
      DomainError,
    );
    await expect(useCase.execute('org-1', {})).rejects.toMatchObject({
      code: 'WASTE_DETECTOR_DISABLED',
      category: 'PRECONDITION_FAILED',
    });
  });
});

describe('procedência (P7)', () => {
  it('o resumo declara janela, versão do detector e do perfil', async () => {
    const h = build();
    const result = await new GetWasteSummaryUseCase(
      h.read as never,
      h.settings as never,
      h.env,
    ).execute('org-1', {});

    expect(result.meta.provenance).toEqual({
      windowDays: 14,
      detectorVersion: DETECTOR_SUITE_VERSION,
      detectorProfileVersion: 'waste-thresholds-v1',
      // DEC-11: itens de outra janela ficam fora do agregado e são **contados**.
      // Sem o número, o total encolhe sem explicação no dia em que alguém mexe
      // em `scoringWindowDays`.
      excludedByWindowMismatch: 4,
    });
    expect(result.meta.asOf).toBe('2026-08-02T06:00:00.000Z');
    expect(result.meta.organization).toEqual({
      baseCurrency: 'BRL',
      recomputingCurrency: false,
    });
  });

  it('a janela é DECLARADA, não usada para filtrar o rollup (DEC-11)', async () => {
    const h = build();

    await new GetWasteRollupUseCase(
      h.read as never,
      h.settings as never,
      h.env,
    ).execute('org-1', { groupBy: 'campaign' });

    // A denormalização em `ads` é sempre da janela ativa e não tem dimensão de
    // janela: o repositório a recebe para **declarar**, e o `groupBy` é o único
    // eixo de agrupamento.
    expect(h.read.rollup).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 14, groupBy: 'campaign' }),
    );
  });

  it('o detalhe carrega a versão DO ITEM, não a ativa da organização', async () => {
    // Um achado gravado sob outra versão continua explicável: responder com a
    // versão de hoje diria que ele foi produzido por uma régua que nunca o viu.
    const h = build({
      findOne: jest.fn().mockResolvedValue(
        itemView({
          detectorVersion: 'v1.9.0',
          detectorProfileVersion: 'waste-thresholds-v0',
          windowDays: 7,
        }),
      ) as never,
    });

    const result = await new GetWasteItemUseCase(
      h.read as never,
      h.settings as never,
      h.env,
    ).execute('org-1', 'item-1');

    expect(result.meta.provenance).toEqual({
      windowDays: 7,
      detectorVersion: 'v1.9.0',
      detectorProfileVersion: 'waste-thresholds-v0',
    });
  });

  it('achado inexistente é 404, não lista vazia', async () => {
    const h = build({ findOne: jest.fn().mockResolvedValue(null) as never });

    await expect(
      new GetWasteItemUseCase(
        h.read as never,
        h.settings as never,
        h.env,
      ).execute('org-1', 'sumiu'),
    ).rejects.toThrow('Achado não encontrado');
  });
});

describe('listagem por cursor', () => {
  it('página sem continuação não emite cursor', async () => {
    const h = build();

    const result = await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      allowingPlans(),
    ).execute('org-1', {});

    expect(result.meta.page).toEqual({ hasMore: false, nextCursor: null });
  });

  it('página com continuação emite cursor sobre o evitável diário', async () => {
    const h = build({
      list: jest
        .fn()
        .mockResolvedValue({ items: [itemView()], hasMore: true }) as never,
    });

    const result = await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      allowingPlans(),
    ).execute('org-1', {});

    // A ordenação padrão é pelo que dá para interromper hoje; o cursor tem de
    // ser emitido sob a mesma chave, senão a página seguinte omite linhas.
    expect(result.meta.page?.nextCursor).toBe(
      encodeCursor({
        sort: 'avoidableDaily:desc',
        keys: [100],
        id: 'item-1',
      }),
    );
  });

  it('cursor emitido sob outra ordenação é recusado', async () => {
    const h = build();
    const alheio = encodeCursor({ sort: 'aiScore:asc', keys: [10], id: 'x' });

    await expect(
      new ListWasteItemsUseCase(
        h.read as never,
        h.settings as never,
        h.env,
        allowingPlans(),
      ).execute('org-1', { cursor: alheio }),
    ).rejects.toMatchObject({ code: 'CURSOR_SORT_MISMATCH' });
  });

  it('evidência degradada na página vira o rótulo PARTIAL', async () => {
    const h = build({
      list: jest.fn().mockResolvedValue({
        items: [itemView(), itemView({ evidenceSufficiency: 'PARTIAL' })],
        hasMore: false,
      }) as never,
    });

    const result = await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      allowingPlans(),
    ).execute('org-1', {});

    // Sem o rótulo, um achado apoiado na linha de base da conta chega à tela
    // indistinguível de um medido contra os pares diretos.
    expect(result.meta.evidenceSufficiency).toBe('PARTIAL');
  });

  it('página inteiramente suficiente não carrega o rótulo', async () => {
    const h = build();

    const result = await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      allowingPlans(),
    ).execute('org-1', {});

    expect(result.meta.evidenceSufficiency).toBeUndefined();
  });

  it('/waste/opportunities filtra por findingKind sem tocar no resto', async () => {
    const h = build();

    await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      allowingPlans(),
    ).execute('org-1', { findingKind: 'OPPORTUNITY', priority: 'HIGH' });

    expect(h.read.list).toHaveBeenCalledWith(
      expect.objectContaining({
        findingKind: 'OPPORTUNITY',
        priority: 'HIGH',
        state: 'open',
      }),
    );
  });

  it('by-ad pagina sobre a denormalização, com cursor próprio', async () => {
    const h = build({
      byAd: jest.fn().mockResolvedValue({
        rows: [
          {
            ad: itemView().ad,
            openCount: 3,
            incurred: itemView().incurred,
            avoidableDaily: itemView().avoidableDaily,
            types: ['ZERO_CONVERSIONS'],
            worstPriority: 'CRITICAL',
            wasteAsOf: new Date('2026-08-02T06:00:00.000Z'),
          },
        ],
        hasMore: true,
      }) as never,
    });

    const result = await new ListWasteByAdUseCase(
      h.read as never,
      h.settings as never,
      h.env,
    ).execute('org-1', {});

    expect(result.meta.page?.hasMore).toBe(true);
    // O cursor é do **anúncio**, não do achado: a lista é por anúncio.
    expect(result.meta.page?.nextCursor).toBe(
      encodeCursor({
        sort: 'avoidableDaily:desc',
        keys: [100],
        id: 'ad-1',
      }),
    );
  });
});

describe('oportunidades são cortadas por plano', () => {
  function denyingPlans() {
    return {
      stateFor: jest.fn().mockResolvedValue({
        allowed: false,
        planLabel: 'Individual',
        featureLabel: 'Oportunidades — onde escalar',
        upgradeTo: 'Profissional',
      }),
    };
  }

  it('recusa a rota dedicada quando o plano não inclui', async () => {
    const h = build();

    await expect(
      new ListWasteItemsUseCase(
        h.read as never,
        h.settings as never,
        h.env,
        denyingPlans() as never,
      ).execute('org-1', {}, 'OPPORTUNITY'),
    ).rejects.toMatchObject({ code: 'PLAN_FEATURE_NOT_INCLUDED' });
  });

  it('recusa também pelo parâmetro — as duas portas servem o mesmo dado', async () => {
    // Protegendo só `/waste/opportunities`, este caminho continuaria servindo
    // oportunidade a quem não a contratou. É a porta que ninguém lembra de testar.
    const h = build();

    await expect(
      new ListWasteItemsUseCase(
        h.read as never,
        h.settings as never,
        h.env,
        denyingPlans() as never,
      ).execute('org-1', { findingKind: 'OPPORTUNITY' }),
    ).rejects.toMatchObject({ code: 'PLAN_FEATURE_NOT_INCLUDED' });
  });

  it('desperdício não consulta o plano — está em todo plano', async () => {
    const plans = denyingPlans();
    const h = build();

    await new ListWasteItemsUseCase(
      h.read as never,
      h.settings as never,
      h.env,
      plans as never,
    ).execute('org-1', {});

    expect(plans.stateFor).not.toHaveBeenCalled();
  });
});
