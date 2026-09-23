import { Injectable, NotFoundException } from '@nestjs/common';
import { DEFAULT_DETECTOR_PROFILE_VERSION } from 'src/modules/waste/domain/detector-profile';
import { DETECTOR_SUITE_VERSION } from 'src/modules/waste/domain/detectors';
import {
  WasteReadRepositoryInterface,
  type WasteRollupGroupBy,
} from 'src/modules/waste/domain/ports/waste-read.repository';
import { WasteSettingsReader } from 'src/modules/waste/domain/ports/waste-settings.reader';
import {
  ListWasteItemsQueryDto,
  WasteRollupQueryDto,
  WasteSummaryQueryDto,
} from 'src/modules/waste/application/dtos/waste-query.dto';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  decodeCursor,
  encodeCursor,
} from 'src/shared/infrastructure/http/pagination/cursor';
import { resolveLimit } from 'src/shared/infrastructure/http/pagination/page-query.dto';

const ITEMS_SORT = 'avoidableDaily:desc';
const ROLLUP_DEFAULT_LIMIT = 25;

/**
 * A superfície de leitura de desperdício (§7.3, §10.8).
 *
 * Duas regras atravessam todas as rotas:
 *
 * 1. **Par de grandezas, nunca uma.** `openAmount` deixou de existir. Reportar
 *    só o incorrido faz o produto prometer recuperar dinheiro que já foi.
 * 2. **A janela é declarada, não filtrada** (DEC-11). A denormalização em `ads`
 *    é sempre da janela ativa da organização e não tem dimensão de janela;
 *    filtrar o join por `window_days` enquanto se soma uma coluna sem janela é
 *    incoerente. Itens remanescentes de outra janela ficam fora e são contados
 *    em `meta.provenance.excludedByWindowMismatch`.
 */
function assertDetectorEnabled(env: EnvService): void {
  if (env.get('WASTE_DETECTOR_V2_ENABLED')) return;

  throw new DomainError({
    code: 'WASTE_DETECTOR_DISABLED',
    category: 'PRECONDITION_FAILED',
    message: 'O detector de desperdício está desligado nesta instalação.',
    remediation: 'Ligue WASTE_DETECTOR_V2_ENABLED para habilitar /waste.',
  });
}

/** A procedência comum: quem produziu o número e sob que régua (P7). */
function provenanceOf(input: {
  windowDays: number;
  profileVersion: string;
  excludedByWindowMismatch?: number;
}) {
  return {
    windowDays: input.windowDays,
    detectorVersion: DETECTOR_SUITE_VERSION,
    detectorProfileVersion: input.profileVersion,
    ...(input.excludedByWindowMismatch
      ? { excludedByWindowMismatch: input.excludedByWindowMismatch }
      : {}),
  };
}

@Injectable()
export class GetWasteSummaryUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: WasteSummaryQueryDto) {
    assertDetectorEnabled(this.env);
    const config = await this.settings.forOrganization(organizationId);

    const summary = await this.read.summary({
      organizationId,
      windowDays: config.windowDays,
      adAccountId: query.adAccountId,
    });

    return envelope(summary, {
      asOf: (summary.asOf ?? new Date()).toISOString(),
      provenance: provenanceOf({
        windowDays: config.windowDays,
        profileVersion: config.detectorProfileVersion,
        excludedByWindowMismatch: summary.excludedByWindowMismatch,
      }),
      organization: {
        baseCurrency: config.baseCurrency,
        recomputingCurrency: config.recomputingCurrency,
      },
    });
  }
}

@Injectable()
export class ListWasteItemsUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly env: EnvService,
    private readonly plans: PlanEntitlementService,
  ) {}

  async execute(
    organizationId: string,
    query: ListWasteItemsQueryDto,
    findingKind: 'WASTE' | 'OPPORTUNITY' = 'WASTE',
  ) {
    assertDetectorEnabled(this.env);

    /**
     * A guarda mora aqui, e não no controller, porque há **duas** portas para o
     * mesmo dado: a rota `/waste/opportunities` e `/waste/items?findingKind=
     * OPPORTUNITY`. Protegendo só a rota dedicada, o parâmetro continuaria
     * servindo oportunidades a quem não as contratou — e seria a porta que
     * ninguém lembra de testar.
     *
     * O desperdício nunca passa por aqui: ele está em todo plano, e uma checagem
     * por requisição para sempre responder "sim" só custaria latência.
     */
    const kind = query.findingKind ?? findingKind;

    if (kind === 'OPPORTUNITY') {
      const state = await this.plans.stateFor({
        organizationId,
        feature: 'opportunities',
      });

      if (!state.allowed) throw planLimitRefusal(state);
    }

    const config = await this.settings.forOrganization(organizationId);
    const limit = resolveLimit(query.limit);
    const cursor = query.cursor
      ? decodeCursor(query.cursor, ITEMS_SORT)
      : undefined;

    const result = await this.read.list({
      organizationId,
      findingKind: kind,
      type: query.type,
      priority: query.priority,
      dataMaturity: query.dataMaturity,
      adId: query.adId,
      adAccountId: query.adAccountId,
      campaignId: query.campaignId,
      adSetId: query.adSetId,
      state: query.state ?? 'open',
      minAvoidableDailyBase: query.minAvoidableDailyBase,
      limit,
      cursor: cursor ? { keys: cursor.keys, id: cursor.id } : undefined,
    });

    const last = result.items.at(-1);
    const nextCursor =
      result.hasMore && last
        ? encodeCursor({
            sort: ITEMS_SORT,
            keys: [last.avoidableDaily.valueBase],
            id: last.id,
          })
        : null;

    const degraded = result.items.some(
      (item) => item.evidenceSufficiency !== 'SUFFICIENT',
    );

    return envelope(result.items, {
      asOf: (last?.lastSeenAt ?? new Date()).toISOString(),
      provenance: provenanceOf({
        windowDays: config.windowDays,
        profileVersion: config.detectorProfileVersion,
      }),
      page: { hasMore: result.hasMore, nextCursor },
      // O rótulo declara que **algum** item da página se apoia em evidência
      // degradada — benchmark de conta em vez de conjunto, série curta. Sem ele,
      // um achado `PARTIAL` chega à tela indistinguível de um pleno.
      ...(degraded ? { evidenceSufficiency: 'PARTIAL' as const } : {}),
    });
  }
}

@Injectable()
export class GetWasteItemUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, id: string) {
    assertDetectorEnabled(this.env);

    const item = await this.read.findOne(organizationId, id);
    if (!item) throw new NotFoundException('Achado não encontrado');

    return envelope(item, {
      asOf: item.lastSeenAt.toISOString(),
      dataMaturity: item.dataMaturity ?? undefined,
      evidenceSufficiency: item.evidenceSufficiency,
      provenance: {
        windowDays: item.windowDays,
        detectorVersion: item.detectorVersion,
        detectorProfileVersion: item.detectorProfileVersion,
      },
    });
  }
}

@Injectable()
export class GetAdWasteUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, adId: string) {
    assertDetectorEnabled(this.env);

    const items = await this.read.openForAd(organizationId, adId);
    const asOf = items.at(0)?.lastSeenAt ?? new Date();

    return envelope(items, {
      asOf: asOf.toISOString(),
      provenance: {
        windowDays: items.at(0)?.windowDays ?? 0,
        detectorProfileVersion:
          items.at(0)?.detectorProfileVersion ??
          DEFAULT_DETECTOR_PROFILE_VERSION,
      },
    });
  }
}

@Injectable()
export class GetWasteRollupUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: WasteRollupQueryDto) {
    assertDetectorEnabled(this.env);
    const config = await this.settings.forOrganization(organizationId);

    const result = await this.read.rollup({
      organizationId,
      groupBy: (query.groupBy ?? 'campaign') as WasteRollupGroupBy,
      windowDays: config.windowDays,
      limit: Math.min(query.limit ?? ROLLUP_DEFAULT_LIMIT, 100),
    });

    return envelope(result.rows, {
      asOf: new Date().toISOString(),
      provenance: provenanceOf({
        windowDays: config.windowDays,
        profileVersion: config.detectorProfileVersion,
        excludedByWindowMismatch: result.excludedByWindowMismatch,
      }),
      organization: {
        baseCurrency: result.baseCurrency ?? config.baseCurrency,
        recomputingCurrency: config.recomputingCurrency,
      },
    });
  }
}

@Injectable()
export class ListWasteByAdUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: ListWasteItemsQueryDto) {
    assertDetectorEnabled(this.env);
    const config = await this.settings.forOrganization(organizationId);
    const limit = resolveLimit(query.limit);
    const cursor = query.cursor
      ? decodeCursor(query.cursor, ITEMS_SORT)
      : undefined;

    const result = await this.read.byAd({
      organizationId,
      limit,
      cursor: cursor
        ? { avoidableDailyBase: Number(cursor.keys[0]), id: cursor.id }
        : undefined,
    });

    const last = result.rows.at(-1);
    const nextCursor =
      result.hasMore && last
        ? encodeCursor({
            sort: ITEMS_SORT,
            keys: [last.avoidableDaily.valueBase],
            id: last.ad.id,
          })
        : null;

    return envelope(result.rows, {
      asOf: (last?.wasteAsOf ?? new Date()).toISOString(),
      provenance: provenanceOf({
        windowDays: config.windowDays,
        profileVersion: config.detectorProfileVersion,
      }),
      page: { hasMore: result.hasMore, nextCursor },
    });
  }
}

/**
 * `GET /ads/{id}/evidence` — o que a detecção não pôde julgar neste anúncio, e
 * quando deve poder (P7).
 *
 * Complementa `GET /ads/{id}/waste`: lá, lista vazia é "olhamos e não
 * encontramos"; aqui fica o que **não deu para olhar**, e por quê.
 */
@Injectable()
export class GetAdEvidenceUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, adId: string) {
    assertDetectorEnabled(this.env);

    const view = await this.read.evidenceForAd({ organizationId, adId });
    if (!view) {
      throw new NotFoundException('Anúncio não encontrado.');
    }

    return envelope(
      { ...view, asOf: view.asOf?.toISOString() ?? null },
      {
        asOf: (view.asOf ?? new Date()).toISOString(),
        provenance: { detectorVersion: DETECTOR_SUITE_VERSION },
      },
    );
  }
}

/**
 * `GET /waste/evidence` — o silêncio explicado da organização inteira.
 *
 * É o que a tela mostra quando a lista de desperdício está vazia: quantos
 * anúncios ainda esperam evidência, por quê, e quando o primeiro deles deve
 * poder ser julgado.
 */
@Injectable()
export class GetEvidenceSummaryUseCase {
  constructor(
    private readonly read: WasteReadRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: WasteSummaryQueryDto) {
    assertDetectorEnabled(this.env);

    const summary = await this.read.evidenceSummary({
      organizationId,
      adAccountId: query.adAccountId,
    });

    return envelope(
      { ...summary, asOf: summary.asOf?.toISOString() ?? null },
      {
        asOf: (summary.asOf ?? new Date()).toISOString(),
        provenance: { detectorVersion: DETECTOR_SUITE_VERSION },
      },
    );
  }
}
