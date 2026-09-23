import { Injectable } from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { summarizeCoverage } from 'src/modules/analytics/domain/campaign-coverage';
import { CampaignCoverageRepositoryInterface } from 'src/modules/analytics/domain/ports/campaign-coverage.repository';

const COVERAGE_VERSION = 'coverage-1.0.0';

/**
 * `GET /analytics/coverage` — as campanhas ativas que a Allva não analisa.
 *
 * Acompanha os totais do painel: sem esta rota, um total que omite parte do
 * investimento não teria como dizer que omite.
 */
@Injectable()
export class GetCoverageUseCase {
  constructor(
    private readonly coverage: CampaignCoverageRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
  ) {}

  async execute(accountId: string) {
    const owner = await this.scope.resolveForAccount(accountId);
    const now = new Date();

    // Sem organização não há campanha; zero lacunas afirmaria cobertura total.
    if (!owner.organizationId) {
      return envelope(null, {
        asOf: now.toISOString(),
        provenance: { engineVersion: COVERAGE_VERSION },
      });
    }

    const rows = await this.coverage.listWithoutAnalyzableAds({
      organizationId: owner.organizationId,
      now,
    });

    return envelope(summarizeCoverage(rows), {
      asOf: now.toISOString(),
      provenance: { engineVersion: COVERAGE_VERSION },
    });
  }
}
