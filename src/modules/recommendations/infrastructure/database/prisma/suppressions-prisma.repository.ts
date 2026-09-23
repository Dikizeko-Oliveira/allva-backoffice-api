import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import type { RecommendationKind } from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import type { SuppressionScope } from 'src/modules/recommendations/domain/suppression';
import {
  SuppressionsRepositoryInterface,
  type SuppressionView,
} from 'src/modules/recommendations/domain/ports/suppressions.repository';

@Injectable()
export class SuppressionsPrismaRepository extends SuppressionsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(organizationId: string): Promise<SuppressionView[]> {
    const rows = await this.prisma.recommendationSuppression.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toView);
  }

  async create(input: {
    organizationId: string;
    kind: RecommendationKind;
    scope: SuppressionScope;
    scopeId: string | null;
    reason: string;
    createdByAccountId: string;
    expiresAt: Date | null;
  }): Promise<SuppressionView> {
    const row = await this.prisma.recommendationSuppression.create({
      data: {
        organizationId: input.organizationId,
        kind: input.kind,
        scope: input.scope,
        scopeId: input.scopeId,
        reason: input.reason,
        createdByAccountId: input.createdByAccountId,
        expiresAt: input.expiresAt,
      },
    });

    return toView(row);
  }

  async remove(id: string, organizationId: string): Promise<boolean> {
    const result = await this.prisma.recommendationSuppression.deleteMany({
      where: { id, organizationId },
    });

    return result.count > 0;
  }

  async purgeExpired(now: Date): Promise<number> {
    const result = await this.prisma.recommendationSuppression.deleteMany({
      where: { expiresAt: { not: null, lte: now } },
    });

    return result.count;
  }
}

function toView(row: {
  id: string;
  kind: string;
  scope: string;
  scopeId: string | null;
  reason: string;
  createdByAccountId: string;
  createdAt: Date;
  expiresAt: Date | null;
}): SuppressionView {
  return {
    id: row.id,
    kind: row.kind as RecommendationKind,
    scope: row.scope as SuppressionScope,
    scopeId: row.scopeId,
    reason: row.reason,
    createdByAccountId: row.createdByAccountId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
