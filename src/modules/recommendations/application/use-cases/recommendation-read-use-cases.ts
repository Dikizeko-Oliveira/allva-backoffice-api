import { Injectable, NotFoundException } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  decodeCursor,
  encodeCursor,
} from 'src/shared/infrastructure/http/pagination/cursor';
import { resolveLimit } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { SuppressionsRepositoryInterface } from 'src/modules/recommendations/domain/ports/suppressions.repository';
import { ListRecommendationsQueryDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { RECOMMENDATION_ENGINE_VERSION } from 'src/modules/recommendations/domain/contracts/engine-version';
import { MEASUREMENT_VERSION } from 'src/modules/recommendations/domain/outcome-measurement';

const SORT = 'priority:desc';

export function assertEngineEnabled(env: EnvService): void {
  if (env.get('RECOMMENDATION_ENGINE_ENABLED')) return;

  throw new DomainError({
    code: 'RECOMMENDATION_ENGINE_DISABLED',
    category: 'PRECONDITION_FAILED',
    message: 'O motor de recomendações está desligado nesta instalação.',
    remediation:
      'Ligue RECOMMENDATION_ENGINE_ENABLED para habilitar /recommendations.',
  });
}

@Injectable()
export class ListRecommendationsUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: ListRecommendationsQueryDto) {
    assertEngineEnabled(this.env);

    const limit = resolveLimit(query.limit);
    const cursor = query.cursor ? decodeCursor(query.cursor, SORT) : undefined;

    const result = await this.recommendations.list({
      organizationId,
      status: query.status ?? 'NEW',
      kind: query.kind,
      adId: query.adId,
      advisory: query.advisory,
      blocked: query.blocked,
      limit,
      cursor: cursor ? { keys: cursor.keys, id: cursor.id } : undefined,
    });

    const last = result.items.at(-1);
    const nextCursor =
      result.hasMore && last
        ? encodeCursor({ sort: SORT, keys: [last.priority], id: last.id })
        : null;

    return envelope(result.items, {
      asOf: (last?.evidenceAsOf ?? new Date()).toISOString(),
      provenance: { engineVersion: RECOMMENDATION_ENGINE_VERSION },
      page: { hasMore: result.hasMore, nextCursor },
    });
  }
}

@Injectable()
export class GetRecommendationUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, id: string) {
    assertEngineEnabled(this.env);

    const item = await this.recommendations.findOne(organizationId, id);
    if (!item) throw new NotFoundException('Recomendação não encontrada');

    return envelope(item, {
      asOf: item.evidenceAsOf.toISOString(),
      dataMaturity: item.dataMaturity ?? undefined,
      provenance: { engineVersion: item.engineVersion },
    });
  }
}

/**
 * `/recommendations/impact-summary` — **três tipos separados, nunca somados**
 * (§9.7).
 *
 * `SAVINGS`, `EFFICIENCY_GAIN` e `REVENUE_UPLIFT` têm naturezas e confianças
 * diferentes: gasto interrompido é verificável diretamente, receita adicional é
 * projeção sujeita a sazonalidade e leilão. Somá-los produziria um número de
 * capa cuja maior parcela é a menos confiável.
 *
 * O **realizado vem de `RecommendationOutcome` por join** (B8), nunca de
 * `impacts[]`, e desde A2-S9 ele existe de fato — o que muda o que esta rota
 * precisa dizer:
 *
 * > **`observedDelta`, jamais `causedSavings`** (P7, D6). Isto é medição
 * > pré/pós, não atribuição causal. O gasto que parou é real; o que ninguém
 * > pode afirmar é que a economia inteira se deve à recomendação — o orçamento
 * > pode ter migrado para outro anúncio, a sazonalidade pode ter mudado o
 * > leilão. Por isso o bloco `measurement` viaja junto: quantas mediram,
 * > quantas têm confounder, e sob que versão de medição.
 */
@Injectable()
export class GetImpactSummaryUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string) {
    assertEngineEnabled(this.env);

    const summary = await this.recommendations.impactSummary(organizationId);

    return envelope(summary, {
      asOf: new Date().toISOString(),
      provenance: {
        engineVersion: RECOMMENDATION_ENGINE_VERSION,
        /**
         * A versão da medição na procedência, ao lado da do motor (P7).
         *
         * Mais de uma no recorte significa que os números vêm de regras
         * diferentes; declarar a corrente é o mínimo, e `measurement.versions`
         * no corpo diz quais de fato aparecem.
         */
        measurementVersion: MEASUREMENT_VERSION,
      },
      organization: {
        baseCurrency: summary.baseCurrency,
        recomputingCurrency: false,
      },
    });
  }
}

@Injectable()
export class ListSuppressionsUseCase {
  constructor(
    private readonly suppressions: SuppressionsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string) {
    assertEngineEnabled(this.env);

    const items = await this.suppressions.list(organizationId);

    return envelope(items, {
      asOf: new Date().toISOString(),
      provenance: { engineVersion: RECOMMENDATION_ENGINE_VERSION },
    });
  }
}

@Injectable()
export class RemoveSuppressionUseCase {
  constructor(
    private readonly suppressions: SuppressionsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, id: string) {
    assertEngineEnabled(this.env);

    const removed = await this.suppressions.remove(id, organizationId);
    if (!removed) throw new NotFoundException('Supressão não encontrada');

    return envelope(
      { id, removed: true },
      {
        asOf: new Date().toISOString(),
        provenance: { engineVersion: RECOMMENDATION_ENGINE_VERSION },
      },
    );
  }
}
