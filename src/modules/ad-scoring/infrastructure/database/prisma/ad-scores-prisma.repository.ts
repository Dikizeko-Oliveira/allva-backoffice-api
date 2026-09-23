import { Injectable } from '@nestjs/common';
import {
  AdScoreDenormalization,
  AdScoreNarrativeWrite,
  AdScoreWrite,
  AdScoresRepositoryInterface,
} from 'src/modules/ad-scoring/domain/ports/ad-scores.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';

@Injectable()
export class AdScoresPrismaRepository extends AdScoresRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * **Append-only** (§12.5): `createMany`, nunca `update`.
   *
   * Recalcular no lugar apagaria a evidência de como o score era ontem — e é
   * essa evidência que responde "por que este anúncio caiu?", que é a pergunta
   * que o produto existe para responder.
   */
  async appendMany(scores: AdScoreWrite[]): Promise<Map<string, string>> {
    if (scores.length === 0) return new Map();

    const rows = scores.map((score) => ({
      adId: score.adId,
      organizationId: score.organizationId,
      creativeId: score.creativeId,
      scoreDate: score.scoreDate,
      windowStart: score.windowStart,
      windowEnd: score.windowEnd,
      windowDays: score.windowDays,
      algoVersion: score.algoVersion,
      priorWeight: score.priorWeight,
      aiScore: score.aiScore,
      aiConfidence: score.aiConfidence,
      componentCoverage: score.componentCoverage,
      coverageRatio: score.coverageRatio,
      platformCoverageMax: score.platformCoverageMax,
      components: toPrismaJson(score.components as never),
      context: toPrismaJson(score.context ?? undefined),
      seriesDiscontinuity: score.seriesDiscontinuity,
      frozenAt: score.frozenAt,
      inputDigest: score.inputDigest,
    }));

    await this.prisma.adScore.createMany({ data: rows });

    // `createMany` não devolve ids. Relê as linhas recém-gravadas pela chave
    // natural: é uma consulta a mais, e ela existe para que a denormalização em
    // `ads` aponte para a linha certa — `currentScoreId` sem lastro seria uma FK
    // apontando para o score de ontem.
    const persisted = await this.prisma.adScore.findMany({
      where: {
        adId: { in: scores.map((score) => score.adId) },
        scoreDate: scores[0].scoreDate,
        algoVersion: scores[0].algoVersion,
      },
      select: { id: true, adId: true, scoredAt: true },
      orderBy: { scoredAt: 'desc' },
    });

    const byAd = new Map<string, string>();
    for (const row of persisted) {
      if (!byAd.has(row.adId)) byAd.set(row.adId, row.id);
    }

    return byAd;
  }

  /**
   * O único `update` deste repositório, e ele **não** contradiz o append-only.
   *
   * A regra de §12.5 protege a série: nenhum score de ontem é reescrito, porque
   * é dela que sai a resposta a "por que este anúncio caiu?". Aqui a linha
   * escrita é a que acabou de nascer nesta mesma execução, e o campo é o texto
   * que a descreve — nada do passado muda. Gravar a narrativa junto no
   * `createMany` seria o caminho sem `update`, e é justamente o que P4 proíbe:
   * a chamada de LLM precisa acontecer **depois** de o número estar salvo.
   *
   * `updateMany` por id em lote não serve: cada linha recebe um texto
   * diferente. A transação mantém o conjunto atômico — meia dúzia de narrativas
   * gravadas e o resto não deixaria a tela com um recorte que ninguém pediu.
   */
  async attachNarratives(narratives: AdScoreNarrativeWrite[]): Promise<void> {
    if (narratives.length === 0) return;

    await this.prisma.$transaction(
      narratives.map((item) =>
        this.prisma.adScore.update({
          where: { id: item.scoreId },
          data: {
            aiNarrative: item.narrative,
            aiProvider: item.provider,
            aiModel: item.model,
          },
        }),
      ),
    );
  }

  async lastDigestByAd(input: {
    organizationId: string;
    adIds: string[];
    algoVersion: string;
  }): Promise<Map<string, string>> {
    if (input.adIds.length === 0) return new Map();

    const rows = await this.prisma.adScore.findMany({
      where: {
        organizationId: input.organizationId,
        adId: { in: input.adIds },
        algoVersion: input.algoVersion,
      },
      select: { adId: true, inputDigest: true, scoredAt: true },
      orderBy: { scoredAt: 'desc' },
    });

    const byAd = new Map<string, string>();
    for (const row of rows) {
      if (!byAd.has(row.adId)) byAd.set(row.adId, row.inputDigest);
    }

    return byAd;
  }

  /**
   * O score de referência do delta — **por linhagem**, não por `adId`.
   *
   * Recriar o anúncio (troca de criativo no Meta gera id novo) não pode
   * recomeçar o histórico de saúde do zero: o delta de 7 dias tem de atravessar
   * a recriação, senão toda ação que recria produz um "anúncio novo sem
   * histórico" no dia seguinte à execução (§3.6).
   */
  async scoreAtOrBefore(input: {
    organizationId: string;
    lineageIds: string[];
    date: Date;
    notBefore: Date;
    algoVersion: string;
  }): Promise<Map<string, { aiScore: number; scoreDate: Date }>> {
    if (input.lineageIds.length === 0) return new Map();

    const rows = await this.prisma.adScore.findMany({
      where: {
        organizationId: input.organizationId,
        algoVersion: input.algoVersion,
        // A janela tem os dois lados. O piso é o que impede um score velho de
        // virar base de um delta de 7 dias — ver `notBefore` na porta.
        scoreDate: { lte: input.date, gte: input.notBefore },
        ad: { lineageId: { in: input.lineageIds } },
      },
      select: {
        aiScore: true,
        scoreDate: true,
        ad: { select: { lineageId: true } },
      },
      orderBy: { scoreDate: 'desc' },
    });

    const byLineage = new Map<string, { aiScore: number; scoreDate: Date }>();
    for (const row of rows) {
      const lineageId = row.ad.lineageId;
      if (byLineage.has(lineageId)) continue;
      byLineage.set(lineageId, {
        aiScore: row.aiScore,
        scoreDate: row.scoreDate,
      });
    }

    return byLineage;
  }

  async proxyBasedByAd(input: {
    organizationId: string;
    adIds: string[];
    algoVersion: string;
  }): Promise<Map<string, boolean>> {
    if (input.adIds.length === 0) return new Map();

    const rows = await this.prisma.adScore.findMany({
      where: {
        organizationId: input.organizationId,
        adId: { in: input.adIds },
        algoVersion: input.algoVersion,
      },
      select: { adId: true, components: true, scoredAt: true },
      orderBy: { scoredAt: 'desc' },
    });

    const byAd = new Map<string, boolean>();

    for (const row of rows) {
      if (byAd.has(row.adId)) continue;

      const components = row.components as {
        negativeFeedbackRisk?: { proxyBased?: boolean };
      } | null;

      byAd.set(row.adId, components?.negativeFeedbackRisk?.proxyBased === true);
    }

    return byAd;
  }

  /**
   * A denormalização de leitura em `ads` (§5.4).
   *
   * `currentScoreCoverage` recebe **`coverageRatio`** — quem monta o input já
   * resolveu isso, e o comentário do port explica por quê: §12.4 diz que a
   * coluna existe para os pisos serem aplicáveis em `WHERE`, e os pisos incidem
   * sobre a razão, não sobre a cobertura absoluta.
   */
  async denormalizeIntoAds(updates: AdScoreDenormalization[]): Promise<void> {
    for (const update of updates) {
      await this.prisma.ad.update({
        where: { id: update.adId },
        data: {
          currentScoreId: update.currentScoreId,
          currentAiScore: update.currentAiScore,
          currentScoreConfidence: update.currentScoreConfidence,
          currentScoreCoverage: update.currentScoreCoverage,
          scoreDelta7d: update.scoreDelta7d,
          scoreAsOf: update.scoreAsOf,
        },
      });
    }
  }
}
