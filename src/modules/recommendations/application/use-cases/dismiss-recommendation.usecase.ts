import { Injectable, NotFoundException } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import {
  DEFAULT_SUPPRESSION_DAYS,
  DEFAULT_SUPPRESSION_SCOPE,
  type SuppressionScope,
} from 'src/modules/recommendations/domain/suppression';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { SuppressionsRepositoryInterface } from 'src/modules/recommendations/domain/ports/suppressions.repository';
import { DismissRecommendationDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { assertEngineEnabled } from './recommendation-read-use-cases';

/**
 * `POST /recommendations/{id}/dismiss` — **dispensa cria supressão** (§9.4 3d).
 *
 * As duas coisas juntas, sempre. Marcar `DISMISSED` sem criar a supressão faria
 * a geração de amanhã reapresentar o mesmo plano, e o usuário concluiria — com
 * razão — que o produto não escuta. A taxa de dispensa por `kind` é métrica de
 * produto: assim como `USER_DIRECT` sinaliza recomendação faltante (P3),
 * dispensa recorrente sinaliza política errada (P8).
 */
@Injectable()
export class DismissRecommendationUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly suppressions: SuppressionsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    id: string;
    body: DismissRecommendationDto;
  }) {
    assertEngineEnabled(this.env);

    const recommendation = await this.recommendations.findOne(
      input.organizationId,
      input.id,
    );

    if (!recommendation) {
      throw new NotFoundException('Recomendação não encontrada');
    }

    const now = new Date();
    const scope: SuppressionScope =
      input.body.scope ?? DEFAULT_SUPPRESSION_SCOPE;

    const marked = await this.recommendations.markStatus({
      id: input.id,
      organizationId: input.organizationId,
      status: 'DISMISSED',
      reason: input.body.reason,
    });

    if (!marked) {
      // Outra requisição mudou o status entre a leitura e a escrita. Criar a
      // supressão mesmo assim silenciaria o kind por causa de uma dispensa que
      // não aconteceu.
      throw new NotFoundException(
        'A recomendação mudou de estado; recarregue antes de dispensar.',
      );
    }

    const suppression = await this.suppressions.create({
      organizationId: input.organizationId,
      kind: recommendation.kind,
      scope,
      // `ORGANIZATION` não tem id a casar — a supressão vale para tudo.
      scopeId: scopeIdFor(scope, recommendation),
      reason: input.body.reason,
      createdByAccountId: input.accountId,
      // `0` é permanente por escolha explícita do usuário; ausente usa o padrão.
      expiresAt:
        input.body.days === 0
          ? null
          : addDays(now, input.body.days ?? DEFAULT_SUPPRESSION_DAYS),
    });

    return envelope(
      {
        id: input.id,
        status: 'DISMISSED' as const,
        suppression: {
          id: suppression.id,
          kind: suppression.kind,
          scope: suppression.scope,
          scopeId: suppression.scopeId,
          expiresAt: suppression.expiresAt,
        },
      },
      {
        asOf: now.toISOString(),
        provenance: { engineVersion: recommendation.engineVersion },
      },
    );
  }
}

function scopeIdFor(
  scope: SuppressionScope,
  recommendation: {
    ad: { id: string; adSet: { id: string } | null; campaign: { id: string } };
  },
): string | null {
  if (scope === 'ORGANIZATION') return null;
  if (scope === 'AD') return recommendation.ad.id;
  if (scope === 'CAMPAIGN') return recommendation.ad.campaign.id;
  return recommendation.ad.adSet?.id ?? recommendation.ad.id;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}
