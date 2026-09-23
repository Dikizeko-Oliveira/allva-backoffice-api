import { Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import type { ComparableAd } from 'src/modules/creative-lab/domain/cross-ad-dispersion';
import {
  CANDIDATE_POOL_SIZE,
  MIN_CANDIDATE_SCORE,
  type CreativeCandidate,
} from 'src/modules/creative-lab/domain/creative-candidates';
import type { SuggestionSet } from 'src/modules/creative-lab/domain/creative-suggestions';
import {
  CREATIVE_SUGGESTIONS_SCHEMA_VERSION,
  parseSuggestionColumn,
} from 'src/modules/creative-lab/domain/schemas/creative-suggestions.schema';
import {
  CreativeAnalysisRepositoryInterface,
  type AnalysisSubject,
  type PersistAnalysisInput,
  type StoredAnalysis,
} from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class CreativeAnalysisPrismaRepository extends CreativeAnalysisRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async subjectFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<AnalysisSubject | null> {
    const ad = await this.prisma.ad.findFirst({
      where: { id: input.adId, organizationId: input.organizationId },
      select: {
        id: true,
        adSetId: true,
        name: true,
        platform: true,
        accountId: true,
        adAccountId: true,
        creativeId: true,
        currentScoreId: true,
        creative: {
          select: {
            id: true,
            contentHash: true,
            // O texto no ar: entrada das regras factuais de sugestão e do
            // contexto da geração de copy. Lido no mesmo instante que o resto.
            title: true,
            body: true,
            callToAction: true,
          },
        },
      },
    });

    // Anúncio sem criativo sincronizado não tem par a analisar. Devolver `null`
    // o torna um 404 do anúncio — que é o que ele é, do ponto de vista desta
    // rota: não há `(Creative, Ad)` aqui.
    if (!ad?.creative) return null;

    return {
      adId: ad.id,
      adSetId: ad.adSetId,
      adName: ad.name,
      platform: ad.platform,
      creativeId: ad.creative.id,
      // Criativo sem `contentHash` é o que a plataforma entregou sem o campo.
      // O `id` no lugar mantém a comparação funcionando — dois anúncios do
      // mesmo criativo continuam casando — e só perde a deduplicação entre
      // criativos de conteúdo idêntico e ids diferentes.
      contentHash: ad.creative.contentHash ?? ad.creative.id,
      /**
       * P9 aplicado à análise criativa: o digest é `score + conteúdo`. Sem o
       * `contentHash`, trocar o criativo sem mudar o score não recomputaria a
       * análise; sem o score, uma queda de desempenho no mesmo criativo
       * passaria despercebida. As duas entradas juntas são o que a coluna do
       * schema declara.
       */
      metricsDigest: ad.currentScoreId
        ? `${ad.currentScoreId}:${ad.creative.contentHash ?? ad.creative.id}`
        : null,
      accountId: ad.accountId,
      adAccountId: ad.adAccountId,
      copy: {
        headline: ad.creative.title,
        body: ad.creative.body,
        callToAction: ad.creative.callToAction,
      },
    };
  }

  /**
   * Os anúncios do mesmo criativo, **com score** (§11.3).
   *
   * A denormalização de `ads` é o que torna esta consulta barata: `currentAiScore`,
   * `currentScoreConfidence` e `currentScoreCoverage` já vivem na linha do
   * anúncio (A9). Ir à série de `ad_scores` para montar a comparação leria uma
   * tabela append-only por anúncio, e a tela de análise pagaria por isso.
   *
   * **`currentScoreCoverage` guarda a razão** (decisão 3 de A2-S4), e a
   * comparação de §11.3 precisa da cobertura **absoluta** para decidir
   * compatibilidade: dois anúncios de plataformas diferentes podem ter razão 1,0
   * cobrindo números muito distintos de componentes. A razão é o que temos
   * denormalizado, e usá-la aqui torna a compatibilidade **mais** permissiva
   * entre plataformas — declarado, não silenciado.
   */
  async adsOfCreative(input: {
    organizationId: string;
    creativeId: string;
  }): Promise<ComparableAd[]> {
    const rows = await this.prisma.ad.findMany({
      where: {
        organizationId: input.organizationId,
        creativeId: input.creativeId,
        currentAiScore: { not: null },
      },
      select: {
        id: true,
        adSetId: true,
        currentAiScore: true,
        currentScoreConfidence: true,
        currentScoreCoverage: true,
      },
    });

    return rows.map((row) => ({
      adId: row.id,
      aiScore: row.currentAiScore ?? 0,
      aiConfidence: row.currentScoreConfidence ?? 0,
      componentCoverage: row.currentScoreCoverage ?? 0,
      adSetId: row.adSetId,
    }));
  }

  /**
   * §11.4 — **criativos já veiculados na conta**, e só eles.
   *
   * A origem é fechada por P1: a Allva não gera mídia, e a superfície de upload
   * pré-veiculação está fora do escopo da v2.0 (D7.1). Um candidato que a
   * plataforma nunca entregou não tem desempenho medido, e recomendá-lo seria
   * predição pura.
   */
  /**
   * Criativos já veiculados na conta, com desempenho médio (§11.4) — **os
   * melhores, não todos**.
   *
   * ## O que isto corrige
   *
   * A versão anterior fazia `findMany` sobre todos os criativos da conta de
   * anúncios, trazendo junto os anúncios pontuados de cada um, sem paginação e
   * sem filtro de score. Numa conta de 5.000 anúncios era a consulta mais
   * pesada da requisição — e ela roda a cada análise nova, para no fim escolher
   * três candidatos. Era o custo de verdade da análise de criativo, muito acima
   * do token da narrativa.
   *
   * ## Por que a agregação desce para o banco
   *
   * Média, contagem, último uso e conjuntos em que rodou eram calculados em
   * memória sobre o resultado inteiro. São exatamente as quatro coisas que o SQL
   * faz sem materializar linha nenhuma na aplicação.
   *
   * O `HAVING` aplica {@link MIN_CANDIDATE_SCORE} na origem: um criativo abaixo
   * do piso nunca seria candidato, e trazê-lo para a aplicação para descartá-lo
   * lá é o trabalho que a consulta existe para não fazer. A constante vem do
   * domínio — infraestrutura pode ler domínio, e é o que impede o piso de
   * existir em dois lugares com dois valores.
   *
   * ## A ordenação por score é equivalente à do domínio, não uma aproximação
   *
   * `rank` é `averageScore/200 + dissimilarity/2`, e `dissimilarity` vale 1 para
   * todo candidato que sobrevive ao filtro do próprio hash — que roda antes do
   * ranqueamento. Entre os elegíveis, portanto, `rank` é monótono no score, e
   * ordenar por score aqui devolve a mesma ordem. A folga de
   * {@link CANDIDATE_POOL_SIZE} cobre o filtro de descanso, que corta depois.
   */
  async candidatesFor(input: {
    organizationId: string;
    adAccountId: string;
  }): Promise<CreativeCandidate[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        content_hash: string;
        name: string | null;
        external_creative_id: string;
        thumbnail_url: string | null;
        average_score: number;
        sample_size: bigint;
        ran_in_ad_set_ids: string[];
        last_ran_at: Date | null;
      }>
    >`
      SELECT
        c."id",
        c."content_hash",
        c."name",
        c."external_creative_id",
        c."thumbnail_url",
        AVG(a."current_ai_score")::float8 AS average_score,
        COUNT(a."id") AS sample_size,
        -- Todos os conjuntos, não o mais recente: o filtro de descanso pergunta
        -- se o criativo já rodou **neste** conjunto, e uma lista truncada
        -- responderia "não" para um caso em que rodou.
        COALESCE(
          ARRAY_AGG(DISTINCT a."ad_set_id") FILTER (WHERE a."ad_set_id" IS NOT NULL),
          ARRAY[]::text[]
        ) AS ran_in_ad_set_ids,
        MAX(a."score_as_of") AS last_ran_at
      FROM "creatives" c
      JOIN "ads" a
        ON a."creative_id" = c."id"
       AND a."current_ai_score" IS NOT NULL
      WHERE c."organization_id" = ${input.organizationId}
        AND c."ad_account_id" = ${input.adAccountId}
        -- Sem hash não há como medir dissimilaridade, e o domínio já o
        -- descartava depois de o ter carregado.
        AND c."content_hash" IS NOT NULL
      GROUP BY c."id", c."content_hash", c."name",
               c."external_creative_id", c."thumbnail_url"
      HAVING AVG(a."current_ai_score") >= ${MIN_CANDIDATE_SCORE}
      ORDER BY average_score DESC, c."id" ASC
      LIMIT ${CANDIDATE_POOL_SIZE}
    `;

    return rows.map((row) => ({
      creativeId: row.id,
      contentHash: row.content_hash,
      name: row.name,
      externalCreativeId: row.external_creative_id,
      thumbnailUrl: row.thumbnail_url,
      averageScore: row.average_score,
      sampleSize: Number(row.sample_size),
      ranInAdSetIds: row.ran_in_ad_set_ids,
      lastRanAt: row.last_ran_at,
    }));
  }

  /**
   * Append-only por anúncio: `version` incrementa, nada é sobrescrito.
   *
   * A análise de ontem descreve o criativo de ontem. Sobrescrevê-la apagaria
   * exatamente a comparação que torna visível o efeito de uma substituição — e
   * é essa comparação que o outcome de P8 mede depois.
   */
  async persist(input: PersistAnalysisInput): Promise<StoredAnalysis> {
    const previous = await this.prisma.creativeAnalysis.findFirst({
      where: { adId: input.adId, organizationId: input.organizationId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });

    const created = await this.prisma.creativeAnalysis.create({
      data: {
        creativeId: input.creativeId,
        adId: input.adId,
        organizationId: input.organizationId,
        accountId: input.accountId,
        version: (previous?.version ?? 0) + 1,
        status: 'COMPLETED',
        trigger: input.trigger,
        adScoreId: input.adScoreId,
        metricsDigest: input.metricsDigest,
        diagnostics: input.diagnostics as Prisma.InputJsonValue,
        candidates: input.candidates as Prisma.InputJsonValue,
        /**
         * §11.4 passo 5 — as quatro colunas finalmente escritas.
         *
         * Gravadas **antes** de o enriquecimento por IA existir na linha, e é a
         * ordem que sustenta a formulação de P4 desta feature: o determinístico
         * decide o que mudar; o texto novo vem depois e mora em outra tabela.
         */
        hookSuggestions: column(input.suggestions.hook, input.suggestions),
        bodySuggestions: column(input.suggestions.body, input.suggestions),
        ctaSuggestions: column(input.suggestions.cta, input.suggestions),
        formatSuggestions: column(input.suggestions.format, input.suggestions),
        /**
         * §11.4 passo 7 marca `aiAuthored` quando a IA sobrepõe sugestões.
         * Aqui ela **não** sobrepõe: as sugestões saem inteiras de regra pura, e
         * declarar autoria de IA sobre elas seria falso — e o campo é o que R14
         * lê para exigir confirmação de conteúdo de marca.
         */
        aiAuthored: false,
        engineVersion: input.engineVersion,
        // A narrativa vive em `hookSuggestions`? Não: ela é diagnóstico, não
        // sugestão. `aiNarrative` não existe em `CreativeAnalysis` — o campo é
        // de `Recommendation` —, então o texto entra em `diagnostics.narrative`,
        // junto do que ele explica. Duplicá-lo numa coluna própria criaria duas
        // casas para o mesmo texto.
        enrichedByAI: input.narrative !== null,
        aiProvider: input.aiProvider,
        aiModel: input.aiModel,
        startedAt: input.startedAt,
        completedAt: input.completedAt,
      },
    });

    return toStored(created);
  }

  async latestFor(input: {
    organizationId: string;
    adId: string;
  }): Promise<StoredAnalysis | null> {
    const row = await this.prisma.creativeAnalysis.findFirst({
      where: {
        adId: input.adId,
        organizationId: input.organizationId,
        status: 'COMPLETED',
      },
      orderBy: { version: 'desc' },
    });

    return row ? toStored(row) : null;
  }
}

/**
 * Uma coluna de sugestão, no formato do schema versionado.
 *
 * `withheld` é repetido nas quatro de propósito: ele explica por que **aquela**
 * lista está vazia, e uma leitura parcial — a tela que só busca o CTA — perderia
 * a recusa se ela morasse num quinto lugar.
 */
function column(
  items: SuggestionSet['hook'],
  set: SuggestionSet,
): Prisma.InputJsonValue {
  return {
    schemaVersion: CREATIVE_SUGGESTIONS_SCHEMA_VERSION,
    items,
    withheld: set.withheld,
  } as unknown as Prisma.InputJsonValue;
}

function toStored(row: {
  id: string;
  adId: string | null;
  creativeId: string;
  version: number;
  status: string;
  trigger: string;
  metricsDigest: string | null;
  diagnostics: unknown;
  candidates: unknown;
  hookSuggestions: unknown;
  bodySuggestions: unknown;
  ctaSuggestions: unknown;
  formatSuggestions: unknown;
  engineVersion: string;
  enrichedByAI: boolean;
  completedAt: Date | null;
}): StoredAnalysis {
  return {
    id: row.id,
    adId: row.adId,
    creativeId: row.creativeId,
    version: row.version,
    status: row.status,
    trigger: row.trigger,
    metricsDigest: row.metricsDigest,
    diagnostics: row.diagnostics,
    candidates: row.candidates,
    /**
     * Parseado aqui, e não no presenter: o caminho de reuso de P9 devolve a
     * linha guardada sem passar por cálculo nenhum, e é nele que a pessoa
     * reabre a tela. Análises anteriores ao produtor têm `null` nas quatro
     * colunas e caem no conjunto vazio, sem lançar.
     */
    suggestions: {
      hook: parseSuggestionColumn(row.hookSuggestions),
      body: parseSuggestionColumn(row.bodySuggestions),
      cta: parseSuggestionColumn(row.ctaSuggestions),
      format: parseSuggestionColumn(row.formatSuggestions),
    },
    engineVersion: row.engineVersion,
    enrichedByAI: row.enrichedByAI,
    narrative: narrativeOf(row.diagnostics),
    completedAt: row.completedAt,
  };
}

/** A narrativa mora dentro de `diagnostics`, junto do que ela explica. */
function narrativeOf(diagnostics: unknown): string | null {
  if (typeof diagnostics !== 'object' || diagnostics === null) return null;

  const value = (diagnostics as { narrative?: unknown }).narrative;
  return typeof value === 'string' ? value : null;
}
