import { Injectable } from '@nestjs/common';
import { AdScoreReader } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import type { CopyField } from 'src/modules/ads/domain/platform/platform-profile';
import { CreativeAnalysisRepositoryInterface } from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import { CopyGenerationsRepositoryInterface } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import type { CopySubject } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import type { CopyFieldBudget } from 'src/modules/creative-lab/domain/ports/copy-generator.port';
import {
  COPY_GENERATION_CONTEXT_SCHEMA_VERSION,
  type CopyGenerationContext,
  type CopyGenerationInputs,
} from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import type { PersistedCreativeSuggestion } from 'src/modules/creative-lab/domain/schemas/creative-suggestions.schema';

export type BuiltContext = {
  subject: CopySubject;
  context: CopyGenerationContext;
  fieldBudgets: CopyFieldBudget[];
  analysisId: string | null;
  adScoreId: string | null;
  /** Retido pela análise: mexer no texto não é o remédio aqui (§11.3). */
  suggestionsWithheld: string | null;
};

const COPY_FIELDS: CopyField[] = [
  'primaryText',
  'headline',
  'description',
  'callToAction',
];

/**
 * Monta o **snapshot** que vira `CopyGeneration.context` (R9, P7).
 *
 * Separado do serviço de geração porque são dois trabalhos: aqui se lê o mundo
 * — anúncio, criativo, campanha, score, análise —, lá se decide se a chamada
 * pode acontecer e se registra o que ela custou. Juntos, o use case passaria de
 * 150 linhas e a leitura ficaria misturada com a política.
 *
 * **As sugestões são copiadas, não referenciadas.** A análise é append-only e
 * ganha versões novas; uma referência por id leria, meses depois, a sugestão de
 * outra versão — e o `reasoning` da variante passaria a citar uma recomendação
 * que nunca foi feita a ela.
 */
@Injectable()
export class CopyContextBuilder {
  constructor(
    private readonly generations: CopyGenerationsRepositoryInterface,
    private readonly analyses: CreativeAnalysisRepositoryInterface,
    private readonly scores: AdScoreReader,
  ) {}

  async build(input: {
    organizationId: string;
    adId: string;
    inputs: CopyGenerationInputs;
  }): Promise<BuiltContext | null> {
    const subject = await this.generations.subjectFor({
      organizationId: input.organizationId,
      adId: input.adId,
    });

    if (!subject) return null;

    const [scoreMap, analysis] = await Promise.all([
      this.scores.currentByAdIds(input.organizationId, [input.adId]),
      this.analyses.latestFor({
        organizationId: input.organizationId,
        adId: input.adId,
      }),
    ]);

    const score = scoreMap.get(input.adId) ?? null;
    const suggestions = collectSuggestions(analysis);

    const context: CopyGenerationContext = {
      schemaVersion: COPY_GENERATION_CONTEXT_SCHEMA_VERSION,
      ad: {
        id: subject.adId,
        name: subject.adName,
        platform: subject.platform,
        campaignObjective: subject.campaignObjective,
        optimizationGoal: subject.optimizationGoal,
      },
      currentCopy: {
        headline: subject.copy.headline,
        body: subject.copy.body,
        callToAction: subject.copy.callToAction,
        landingPageUrl: subject.landingPageUrl,
      },
      /**
       * **Sem score o pedido não é recusado** — ao contrário da análise, que
       * exige score porque a comparação dela parte dos componentes.
       *
       * Aqui o score é contexto: ele torna a variação melhor informada, e a
       * ausência dele é dita ao modelo em vez de barrar o pedido. Um anúncio
       * recém-criado é justamente o que mais precisa de copy nova.
       */
      score: score
        ? {
            adScoreId: score.adScoreId,
            aiScore: score.aiScore,
            aiConfidence: score.aiConfidence,
            components: Object.fromEntries(
              Object.entries(score.components).map(([name, component]) => [
                name,
                {
                  normalizedValue: component.normalizedValue,
                  confidence: component.confidence,
                  available: component.available,
                },
              ]),
            ),
          }
        : null,
      analysis: analysis
        ? {
            id: analysis.id,
            version: analysis.version,
            verdict: verdictOf(analysis.diagnostics),
          }
        : null,
      suggestions,
      inputs: input.inputs,
    };

    return {
      subject,
      context,
      fieldBudgets: budgetsFor(subject.platform),
      analysisId: analysis?.id ?? null,
      adScoreId: score?.adScoreId ?? null,
      suggestionsWithheld: analysis?.suggestions.hook.withheld ?? null,
    };
  }
}

/**
 * As quatro colunas viram uma lista ordenada por prioridade.
 *
 * A ordem é a de `rankedSuggestions` e é reproduzida aqui em vez de importada
 * porque a entrada é a forma **persistida** — que já passou pelo schema — e não
 * o conjunto em memória. As duas ordenações são a mesma regra; a diferença é de
 * onde o dado vem.
 */
function collectSuggestions(
  analysis: { suggestions: AnalysisSuggestionColumns } | null,
): PersistedCreativeSuggestion[] {
  if (!analysis) return [];

  const weight = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

  return [
    ...analysis.suggestions.hook.items,
    ...analysis.suggestions.body.items,
    ...analysis.suggestions.cta.items,
    ...analysis.suggestions.format.items,
  ].sort(
    (a, b) =>
      weight[a.priority] - weight[b.priority] || b.confidence - a.confidence,
  );
}

type AnalysisSuggestionColumns = {
  hook: { items: PersistedCreativeSuggestion[]; withheld: string | null };
  body: { items: PersistedCreativeSuggestion[] };
  cta: { items: PersistedCreativeSuggestion[] };
  format: { items: PersistedCreativeSuggestion[] };
};

/** O veredito mora dentro de `diagnostics`, junto do que ele explica. */
function verdictOf(diagnostics: unknown): string | null {
  if (typeof diagnostics !== 'object' || diagnostics === null) return null;

  const verdict = (diagnostics as { verdict?: unknown }).verdict;

  if (typeof verdict === 'string') return verdict;
  if (typeof verdict === 'object' && verdict !== null) {
    const value = (verdict as { value?: unknown }).value;
    return typeof value === 'string' ? value : null;
  }

  return null;
}

/**
 * Os limites da plataforma, campo a campo — **todos os quatro, sempre**.
 *
 * Inclusive os que ela não aceita: o motivo declarado vai para o prompt e para a
 * tela. Filtrar aqui faria o modelo inventar um título para uma plataforma que
 * não tem título, e a tela mostrá-lo sem dizer que ele não existe ali.
 */
function budgetsFor(platform: string): CopyFieldBudget[] {
  const profile = platformProfile(platform as Platform);

  return COPY_FIELDS.map((field) => ({
    field,
    profile: profile.copy[field],
  }));
}
