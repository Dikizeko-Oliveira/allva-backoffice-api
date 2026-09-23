import { AnalysisEnrichmentService } from './analysis-enrichment.service';
import type { AnalysisNarrativeRequest } from 'src/modules/creative-lab/domain/ports/analysis-narrator.port';

/**
 * **P4 — o produto inteiro sem uma única chamada de LLM.**
 *
 * > *"Com todos os providers de IA falhando, score, waste e recomendação
 * > continuam sendo produzidos."*
 *
 * A análise criativa entrou nessa lista em A2-S9, e o que este arquivo protege é
 * o contrato que a mantém lá: **a narrativa é campo a mais**. Falha de provider,
 * teto de C9 estourado, ausência de veredito — os três produzem `null` e nada
 * mais muda. Uma exceção subindo daqui derrubaria a análise por causa de um
 * texto opcional.
 */

function request(
  overrides: Partial<AnalysisNarrativeRequest> = {},
): AnalysisNarrativeRequest {
  return {
    organizationId: 'org-1',
    adId: 'ad-1',
    adName: 'Anúncio',
    platform: 'META',
    aiScore: 42,
    aiConfidence: 0.8,
    comparison: {
      compared: [],
      excluded: [],
      dispersion: { measure: 'IQR', value: 12, sampleSize: 4, median: 50 },
      verdict: {
        value: 'AUDIENCE_MISMATCH',
        confidence: 0.7,
        alternativeExplanations: ['lance', 'posicionamento'],
      },
    },
    candidates: { kind: 'ADVISORY', reason: 'sem substituto na conta' },
    ...overrides,
  };
}

function build(
  input: {
    budget?: number | null;
    spent?: number;
    narrate?: jest.Mock;
    planAllowsAi?: boolean;
  } = {},
) {
  const narrator = {
    narrate:
      input.narrate ??
      jest.fn().mockResolvedValue({
        narrative: 'O criativo rende de formas diferentes entre os anúncios.',
        provider: 'openai',
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        fallbackUsed: false,
      }),
  };

  const decisions = {
    record: jest.fn().mockResolvedValue(undefined),
    spentTodayBase: jest.fn().mockResolvedValue(input.spent ?? 0),
  };

  const budgets = {
    budgetFor: jest.fn().mockResolvedValue({
      llmDailyBudgetBase: input.budget === undefined ? 10 : input.budget,
      estimatedCallCostBase: 0.02,
      // O contexto viaja com o orçamento: o custo em moeda-base depende da
      // moeda-base da organização, não do processo.
      pricing: {
        baseCurrency: 'BRL',
        pricingBaseCurrency: 'BRL',
        usdToBase: 5.5,
      },
    }),
  };

  const planEntitlement = {
    allows: jest.fn().mockResolvedValue(input.planAllowsAi ?? true),
  };

  return {
    service: new AnalysisEnrichmentService(
      narrator as never,
      decisions as never,
      budgets as never,
      planEntitlement as never,
    ),
    planEntitlement,
    narrator,
    decisions,
    budgets,
  };
}

const run = (h: ReturnType<typeof build>, req = request()) =>
  h.service.enrich({
    request: req,
    inputDigest: 'digest-1',
    correlationId: null,
  });

describe('a narrativa é campo a mais, nunca um pré-requisito', () => {
  it('caminho feliz: texto, provider e trilha de custo', async () => {
    const h = build();

    const result = await run(h);

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.narrative).toContain('criativo');
    expect(h.decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'creative_diagnosis',
        outcome: 'SUCCEEDED',
        // P9 — o digest da análise viaja para a trilha: é o que torna
        // "recomputo sem mudança de entrada" auditável por query.
        inputDigest: 'digest-1',
      }),
    );
  });

  /**
   * O gate de P4. Provider fora do ar **não** propaga: o diagnóstico
   * determinístico já foi calculado e persistido antes desta chamada.
   */
  it('provider fora do ar ⇒ narrative null, e nada relança', async () => {
    const h = build({
      narrate: jest
        .fn()
        .mockRejectedValue(new Error('todos os providers caíram')),
    });

    const result = await run(h);

    expect(result).toMatchObject({ narrative: null, outcome: 'FAILED' });
    expect(h.decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'FAILED' }),
    );
  });

  it('teto de C9 estourado ⇒ pula, registra o corte e não chama o provider', async () => {
    // Cortar em silêncio tornaria "a narrativa sumiu" e "o provider caiu"
    // indistinguíveis para quem investiga.
    const h = build({ budget: 1, spent: 1 });

    const result = await run(h);

    expect(result.outcome).toBe('SKIPPED_BUDGET');
    expect(h.narrator.narrate).not.toHaveBeenCalled();
    expect(h.decisions.record).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'SKIPPED_BUDGET', provider: 'none' }),
    );
  });

  /**
   * §11.3 recusa concluir abaixo de três anúncios comparáveis. Pagar por um
   * texto que explica a ausência de conclusão gastaria orçamento para dizer
   * "não sei" — que o campo nulo já diz, de graça e sem o risco de o modelo
   * concluir mesmo assim.
   */
  it('sem veredito, não gasta chamada nenhuma', async () => {
    const h = build();

    const result = await run(
      h,
      request({
        comparison: {
          compared: [],
          excluded: [],
          dispersion: null,
          verdict: null,
        },
      }),
    );

    expect(result.narrative).toBeNull();
    expect(h.narrator.narrate).not.toHaveBeenCalled();
    expect(h.budgets.budgetFor).not.toHaveBeenCalled();
  });

  it('falha ao gravar a trilha não derruba a análise', async () => {
    // O diagnóstico já está gravado. Perder a linha de custo é menos grave que
    // perder a resposta.
    const h = build();
    h.decisions.record.mockRejectedValue(new Error('banco fora'));

    const result = await run(h);

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.narrative).not.toBeNull();
  });
});
