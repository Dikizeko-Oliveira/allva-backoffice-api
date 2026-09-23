import { Injectable } from '@nestjs/common';
import {
  AdScoreComponentView,
  AdScoreReader,
  AdScoreView,
  DateRange,
} from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const SCORE_SELECT = {
  id: true,
  adId: true,
  aiScore: true,
  aiConfidence: true,
  componentCoverage: true,
  coverageRatio: true,
  algoVersion: true,
  scoreDate: true,
  scoredAt: true,
  windowDays: true,
  seriesDiscontinuity: true,
  frozenAt: true,
  components: true,
  context: true,
  aiNarrative: true,
} as const;

/**
 * A implementação do port declarado em A2-S2 (D2).
 *
 * O contrato nasceu dois sprints antes da implementação de propósito: `waste` e
 * `creative-lab` dependem **do contrato**, nunca do serviço que calcula, e um
 * port declarado cedo é o que impede o consumidor de importar o cálculo por
 * atalho enquanto ninguém está olhando.
 */
@Injectable()
export class AdScoreReaderPrismaAdapter extends AdScoreReader {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * O score corrente de cada anúncio, **na versão ativa da organização**.
   *
   * Versões em sombra gravam na mesma tabela e são comparadas offline; filtrar
   * por `algoVersion` é o que as mantém invisíveis no produto (§12.5). Sem o
   * filtro, um experimento apareceria na tela do usuário como se fosse o número
   * oficial.
   */
  async currentByAdIds(
    organizationId: string,
    adIds: string[],
  ): Promise<Map<string, AdScoreView>> {
    if (adIds.length === 0) return new Map();

    const activeAlgoVersion = await this.activeAlgoVersion(organizationId);

    const rows = await this.prisma.adScore.findMany({
      where: {
        organizationId,
        adId: { in: adIds },
        algoVersion: activeAlgoVersion,
      },
      select: SCORE_SELECT,
      orderBy: [{ scoreDate: 'desc' }, { scoredAt: 'desc' }],
    });

    const byAd = new Map<string, AdScoreView>();
    for (const row of rows) {
      if (byAd.has(row.adId)) continue;
      byAd.set(row.adId, toView(row));
    }

    return byAd;
  }

  async seriesByLineage(
    organizationId: string,
    lineageId: string,
    range: DateRange,
  ): Promise<AdScoreView[]> {
    const activeAlgoVersion = await this.activeAlgoVersion(organizationId);

    const rows = await this.prisma.adScore.findMany({
      where: {
        organizationId,
        algoVersion: activeAlgoVersion,
        scoreDate: { gte: range.since, lte: range.until },
        // Por LINHAGEM: recriar o anúncio não recomeça o histórico de saúde.
        ad: { lineageId },
      },
      select: SCORE_SELECT,
      orderBy: [{ scoreDate: 'asc' }, { scoredAt: 'asc' }],
    });

    return rows.map(toView);
  }

  /**
   * A versão ativa vem de `OrganizationAdsSettings` (A10/D16), nunca de uma
   * constante de código — é a decisão inteira.
   *
   * A linha existe para toda organização desde a correção de dívida que precedeu
   * este sprint; o fallback aqui é a última rede, e ele registra o default do
   * schema em vez de inventar um valor novo.
   */
  private async activeAlgoVersion(organizationId: string): Promise<string> {
    const settings = await this.prisma.organizationAdsSettings.findUnique({
      where: { organizationId },
      select: { activeAlgoVersion: true },
    });

    return settings?.activeAlgoVersion ?? 'deterministic-v2.2';
  }
}

type ScoreRow = {
  id: string;
  adId: string;
  aiScore: number;
  aiConfidence: number;
  componentCoverage: number;
  coverageRatio: number | null;
  algoVersion: string;
  scoreDate: Date;
  scoredAt: Date;
  windowDays: number;
  seriesDiscontinuity: string | null;
  frozenAt: Date | null;
  components: unknown;
  context: unknown;
  aiNarrative: string | null;
};

function toView(row: ScoreRow): AdScoreView {
  return {
    adId: row.adId,
    adScoreId: row.id,
    aiScore: row.aiScore,
    aiConfidence: row.aiConfidence,
    componentCoverage: row.componentCoverage,
    // Linhas anteriores à coluna não têm a razão. Cair para a cobertura absoluta
    // seria reintroduzir o piso absoluto que DEC-2 recusou; `0` mantém a linha
    // fora das ordenações até ser recalculada, que é o comportamento honesto.
    coverageRatio: row.coverageRatio ?? 0,
    algoVersion: row.algoVersion,
    scoreDate: row.scoreDate,
    scoredAt: row.scoredAt,
    windowDays: row.windowDays,
    // O delta não é coluna de `ad_scores`: ele é derivado por linhagem no
    // cálculo e denormalizado em `ads`. Repeti-lo aqui criaria duas fontes.
    delta7d: null,
    seriesDiscontinuity: row.seriesDiscontinuity,
    frozenAt: row.frozenAt,
    components: (row.components as Record<string, AdScoreComponentView>) ?? {},
    context: (row.context as Record<string, unknown> | null) ?? null,
    narrative: row.aiNarrative,
  };
}
