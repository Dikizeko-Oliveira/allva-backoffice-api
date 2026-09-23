import type { CampaignCoverageRow } from '../campaign-coverage';

export abstract class CampaignCoverageRepositoryInterface {
  /**
   * Campanhas não arquivadas, de conta que o sync ainda lê, **sem nenhum
   * anúncio não arquivado**. O julgamento de "ativa" fica no domínio
   * (`summarizeCoverage`), porque depende do perfil da plataforma.
   */
  abstract listWithoutAnalyzableAds(input: {
    organizationId: string;
    now: Date;
  }): Promise<CampaignCoverageRow[]>;
}
