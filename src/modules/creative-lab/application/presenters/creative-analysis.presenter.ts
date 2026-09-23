import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { StoredAnalysis } from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';

/**
 * A resposta de `POST /ads/{id}/analyze`, montada num lugar só.
 *
 * Os dois caminhos — análise nova e reuso de P9 — devolvem **o mesmo shape**, e
 * `reusedPreviousAnalysis` é a única diferença visível. Duas montagens
 * divergiriam no primeiro campo acrescentado, e o cliente descobriria pela
 * metade dos casos.
 *
 * **A leitura parte do que foi persistido**, não do que acabou de ser calculado.
 * É o que torna o caminho de reuso possível sem recalcular nada — e o que
 * garante que a resposta de hoje descreve a linha que ficou no banco, não uma
 * versão em memória que diverge dela.
 */
export function presentAnalysis(
  stored: StoredAnalysis,
  context: {
    adId: string;
    creativeId: string;
    score: AdScoreView;
    reused: boolean;
    /** O plano vigente inclui a leitura com IA? Resolvido por quem chama. */
    aiReadingIncludedInPlan: boolean;
    /** A cota mensal de análises, já resolvida contra o contrato. */
    quota: { limit: number | null; used: number };
  },
) {
  const diagnostics = (stored.diagnostics ?? {}) as {
    dispersion?: unknown;
    verdict?: unknown;
    comparedAdIds?: string[];
    excluded?: unknown[];
    narrative?: string | null;
  };

  return envelope(
    {
      analysisId: stored.id,
      adId: context.adId,
      creativeId: context.creativeId,
      version: stored.version,
      /**
       * P9 visível na resposta. Sem isto, um cliente que chama duas vezes vê
       * duas respostas idênticas e conclui que a segunda recalculou — e a
       * economia que P9 existe para produzir fica indistinguível de um bug.
       */
      reusedPreviousAnalysis: context.reused,
      score: {
        aiScore: context.score.aiScore,
        aiConfidence: context.score.aiConfidence,
        coverageRatio: context.score.coverageRatio,
      },
      crossAd: {
        dispersion: diagnostics.dispersion ?? null,
        /** `null` abaixo de três anúncios comparáveis — sem conclusão, e dito. */
        verdict: diagnostics.verdict ?? null,
        compared: diagnostics.comparedAdIds?.length ?? 0,
        excluded: diagnostics.excluded ?? [],
      },
      replacement: stored.candidates,
      /**
       * §11.4 passo 5 — **o que mudar no texto, e por quê**.
       *
       * Vem do que foi persistido, como todo o resto: é o que faz o caminho de
       * reuso de P9 devolver a mesma sugestão sem recalcular nada.
       *
       * `withheld` viaja junto e é a metade que a lista vazia não diz. Com
       * `AUDIENCE_MISMATCH`, a análise concluiu que mexer no texto não é o
       * remédio — e omitir o motivo faria a tela ler "não há nada a melhorar",
       * que é o oposto da conclusão.
       */
      suggestions: {
        hook: stored.suggestions.hook.items,
        body: stored.suggestions.body.items,
        cta: stored.suggestions.cta.items,
        format: stored.suggestions.format.items,
        withheld: stored.suggestions.hook.withheld,
      },
      /**
       * **P4 visível na resposta.** `narrative: null` com `enrichedByAI: false`
       * é o contrato quando o provider caiu, o orçamento estourou ou não houve
       * veredito a explicar — e o diagnóstico acima continua o mesmo nos três
       * casos. Omitir os campos faria "a IA não falou" parecer "a IA não
       * existe".
       */
      narrative: diagnostics.narrative ?? null,
      enrichedByAI: stored.enrichedByAI,
      /**
       * Sem isto, `enrichedByAI: false` era mudo sobre a única causa que o
       * usuário pode resolver. A tela mostrava o diagnóstico e nada mais - e
       * "seu plano não inclui" ficava indistinguível de "o provider caiu".
       */
      aiReadingIncludedInPlan: context.aiReadingIncludedInPlan,
      /**
       * O mesmo contrato da geração de copy, e pelo mesmo motivo: descobrir o
       * teto ao bater nele é o pior momento. A tela precisa dizer "restam 3
       * este mês" antes do clique, não depois do 403.
       */
      quota: {
        limit: context.quota.limit,
        used: context.quota.used,
        remaining:
          context.quota.limit === null
            ? null
            : Math.max(context.quota.limit - context.quota.used, 0),
      },
    },
    {
      asOf: (stored.completedAt ?? new Date()).toISOString(),
      provenance: {
        engineVersion: stored.engineVersion,
        algoVersion: context.score.algoVersion,
        windowDays: context.score.windowDays,
      },
      evidenceSufficiency:
        diagnostics.verdict == null ? 'INSUFFICIENT' : 'SUFFICIENT',
    },
  );
}
