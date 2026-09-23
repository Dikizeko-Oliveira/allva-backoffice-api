import { toCanonicalStatus } from 'src/modules/ads/domain/platform/platform-profiles';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';

/**
 * **Cobertura declarada** — função pura.
 *
 * A Allva analisa anúncios. Uma campanha ativa sem nenhum anúncio que o sync
 * consiga ler é gasto que não passa por score, detecção nem recomendação — e,
 * como todo total vem da série por anúncio, some também dos números do painel.
 * É o caso de formatos automatizados que a plataforma não expõe como anúncio
 * (o Smart+ do TikTok, por exemplo, tem rotas próprias que o provider só lê com
 * `TIKTOK_SMART_PLUS_ENABLED` — desligado até a validação contra conta real).
 *
 * Esta função não conserta a lacuna: ela a torna **visível**. Um total que
 * omite parte do investimento sem dizer é pior que um total declaradamente
 * parcial (P7) — e a pessoa precisa saber que aquela campanha não está sendo
 * olhada, em vez de concluir que está tudo bem com ela.
 *
 * ## Quem entra
 *
 * Campanha **ativa** (status canônico `ACTIVE`) sem nenhum anúncio não
 * arquivado. Status que não sabemos ler (`UNKNOWN`) fica de fora de propósito:
 * afirmar "campanha ativa não analisada" sobre uma campanha que talvez esteja
 * pausada seria trocar uma lacuna por um alarme falso.
 */

export type CampaignCoverageRow = {
  campaignId: string;
  campaignName: string;
  platform: Platform;
  /** O status cru da plataforma, como gravado pelo sync. */
  rawStatus: string | null;
  /** O objetivo cru da plataforma — contexto para a tela, nunca decisão aqui. */
  objective: string | null;
  adAccountName: string;
};

export type UncoveredCampaign = CampaignCoverageRow & {
  reason: 'NO_ANALYZABLE_ADS';
};

export type CoverageSummary = {
  uncoveredCampaigns: UncoveredCampaign[];
  total: number;
  byPlatform: Partial<Record<Platform, number>>;
};

/**
 * `rows` são campanhas sem anúncio não arquivado — o recorte vem do banco. Aqui
 * fica só o julgamento de status, que depende do `PlatformProfile` (P6).
 */
export function summarizeCoverage(
  rows: CampaignCoverageRow[],
): CoverageSummary {
  const uncoveredCampaigns: UncoveredCampaign[] = rows
    .filter(
      (row) =>
        row.rawStatus !== null &&
        toCanonicalStatus(row.platform, row.rawStatus) === 'ACTIVE',
    )
    .map((row) => ({ ...row, reason: 'NO_ANALYZABLE_ADS' as const }))
    .sort(
      (a, b) =>
        a.platform.localeCompare(b.platform) ||
        a.campaignName.localeCompare(b.campaignName),
    );

  const byPlatform: Partial<Record<Platform, number>> = {};
  for (const campaign of uncoveredCampaigns) {
    byPlatform[campaign.platform] = (byPlatform[campaign.platform] ?? 0) + 1;
  }

  return { uncoveredCampaigns, total: uncoveredCampaigns.length, byPlatform };
}
