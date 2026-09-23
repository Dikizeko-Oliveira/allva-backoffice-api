import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { evaluateBudget } from 'src/modules/ai/domain/ai-budget';
import { costBaseOf } from 'src/modules/ai/domain/model-pricing';
import type { AiCallOutcome } from 'src/modules/ai/domain/ai-budget';
import { AiBudgetReader } from 'src/modules/ai/domain/ports/ai-budget.reader';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { AiDecisionLogRepositoryInterface } from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import {
  AnalysisNarrator,
  type AnalysisNarrativeRequest,
} from 'src/modules/creative-lab/domain/ports/analysis-narrator.port';

export type AnalysisEnrichment = {
  /** `null` sempre que a IA não pôde ou não deveria falar. Nunca uma desculpa. */
  narrative: string | null;
  provider: string | null;
  model: string | null;
  outcome: AiCallOutcome;
};

/** A versão do prompt, na procedência (D16: `activePromptVersions` por tarefa). */
export const ANALYSIS_PROMPT_VERSION = 'creative-diagnosis-v1';

/**
 * O enriquecimento por IA da análise criativa (§11.2, P4, C9).
 *
 * **A costura que A2-S4 declarou e A2-S9 ligou.** Ela era honesta enquanto
 * vazia — `enrichedByAI: false` no contrato — e continua honesta agora, porque a
 * regra não mudou: **determinístico primeiro, IA por cima**.
 *
 * A dispersão, o veredito e os candidatos já estão calculados e persistidos
 * antes de qualquer chamada acontecer. Falha de provider, orçamento estourado,
 * chave ausente — todos produzem `narrative: null` e **nada mais muda**. Com
 * todos os provedores fora do ar, `POST /ads/{id}/analyze` responde o mesmo
 * diagnóstico.
 *
 * Por isso este serviço **nunca lança**: uma exceção subindo daqui derrubaria a
 * análise inteira por causa de um texto opcional.
 */
@Injectable()
export class AnalysisEnrichmentService {
  private readonly logger = new Logger(AnalysisEnrichmentService.name);

  constructor(
    private readonly narrator: AnalysisNarrator,
    private readonly decisions: AiDecisionLogRepositoryInterface,
    private readonly budgets: AiBudgetReader,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async enrich(input: {
    request: AnalysisNarrativeRequest;
    /** P9 — o digest da análise: mesma entrada, nenhuma chamada nova. */
    inputDigest: string | null;
    correlationId: string | null;
    now?: Date;
  }): Promise<AnalysisEnrichment> {
    const { request } = input;
    const now = input.now ?? new Date();

    /**
     * **Sem veredito, sem narrativa.** §11.3 recusa concluir abaixo de três
     * anúncios comparáveis, e pagar por um texto que explica a ausência de
     * conclusão gastaria orçamento de LLM para dizer "não sei" — que o campo
     * `null` já diz, de graça e sem risco de o modelo concluir mesmo assim.
     */
    if (!request.comparison.verdict) {
      return {
        narrative: null,
        provider: null,
        model: null,
        outcome: 'SKIPPED_BUDGET',
      };
    }

    /**
     * O plano decide antes do orçamento — e `SKIPPED_PLAN`, não
     * `SKIPPED_BUDGET`: chamada nunca oferecida não é teto atingido.
     *
     * A análise determinística já rodou e está persistida; o que o plano governa
     * é o texto por cima dela. `enrichedByAI: false` já é um estado normal do
     * contrato, então a resposta continua honesta sem nenhum campo novo.
     */
    if (
      !(await this.planEntitlement.allows({
        organizationId: request.organizationId,
        feature: 'creative-lab',
      }))
    ) {
      return {
        narrative: null,
        provider: null,
        model: null,
        outcome: 'SKIPPED_PLAN',
      };
    }

    const budget = await this.budgets.budgetFor(request.organizationId);
    const spentBase = await this.decisions.spentTodayBase({
      organizationId: request.organizationId,
      day: now,
    });

    const verdict = evaluateBudget({
      spentBase,
      limitBase: budget.llmDailyBudgetBase,
      /**
       * Estimativa nula = não sabemos precificar nesta moeda-base.
       *
       * Projetar zero faz o teto simplesmente não se aplicar a esta organização,
       * e é a degradação honesta: o custo real também não poderá ser gravado,
       * então não há o que somar. Bloquear seria pior — tiraria a narrativa de
       * quem paga por causa de uma taxa de câmbio que ninguém configurou. O
       * `basis: 'CURRENCY_NOT_CONVERTIBLE'` no log é o que torna isso visível.
       */
      estimatedCostBase: budget.estimatedCallCostBase ?? 0,
    });

    // C9 — estourar o teto **pula o enriquecimento** e registra o corte. Cortar
    // em silêncio tornaria "a narrativa sumiu" e "o provider caiu"
    // indistinguíveis para quem investiga.
    if (!verdict.allowed) {
      await this.record({
        request,
        inputDigest: input.inputDigest,
        correlationId: input.correlationId,
        outcome: 'SKIPPED_BUDGET',
        provider: 'none',
        model: 'none',
      });

      this.logger.warn(
        `ai.skipped_budget task=creative_diagnosis organizationId=${request.organizationId} ` +
          `gasto=${verdict.spentBase} teto=${verdict.limitBase}`,
      );

      return {
        narrative: null,
        provider: null,
        model: null,
        outcome: 'SKIPPED_BUDGET',
      };
    }

    const startedAt = Date.now();

    try {
      const generated = await this.narrator.narrate(request);
      const cost = costBaseOf({
        provider: generated.provider,
        model: generated.model,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        context: budget.pricing,
      });

      if (cost.basis === 'MOST_EXPENSIVE_KNOWN') {
        this.logger.warn(
          `ai.model_not_priced ${generated.provider}/${generated.model} — ` +
            'cobrado pelo mais caro da tabela; adicione o preço em MODEL_PRICES_USD',
        );
      }

      if (cost.basis === 'CURRENCY_NOT_CONVERTIBLE') {
        this.logger.warn(
          `ai.cost_not_priced moedaBase=${budget.pricing.baseCurrency} — ` +
            'teto diário sem efeito',
        );
      }

      await this.record({
        request,
        inputDigest: input.inputDigest,
        correlationId: input.correlationId,
        outcome: 'SUCCEEDED',
        provider: generated.provider,
        model: generated.model,
        latencyMs: Date.now() - startedAt,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        costBase: cost.costBase,
        // A taxa vem do mesmo veredito que produziu o custo — reler a
        // configuração aqui poderia carimbar um câmbio que não foi o usado.
        usdToBaseRate: cost.usdToBaseRate,
        fallbackUsed: generated.fallbackUsed,
        responseText: generated.narrative,
      });

      return {
        narrative: generated.narrative,
        provider: generated.provider,
        model: generated.model,
        outcome: 'SUCCEEDED',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.record({
        request,
        inputDigest: input.inputDigest,
        correlationId: input.correlationId,
        outcome: 'FAILED',
        provider: 'unknown',
        model: 'unknown',
        latencyMs: Date.now() - startedAt,
        errorPayload: { message },
      });

      // **P4**: campo nulo, resto intacto. Nunca relança.
      this.logger.warn(
        `ai.analysis_narrative_failed adId=${request.adId}: ${message} — diagnóstico preservado`,
      );

      return {
        narrative: null,
        provider: null,
        model: null,
        outcome: 'FAILED',
      };
    }
  }

  /**
   * A trilha de C9 — **inclusive quando não houve chamada**.
   *
   * Um corte por orçamento sem linha em `AIDecisionLog` seria indistinguível de
   * um provider que nunca foi chamado, e é justamente o corte que alguém
   * investiga ao perguntar por que a narrativa sumiu.
   */
  private async record(input: {
    request: AnalysisNarrativeRequest;
    inputDigest: string | null;
    correlationId: string | null;
    outcome: AiCallOutcome;
    provider: string;
    model: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    costBase?: number | null;
    /** A taxa que produziu `costBase`, vinda do próprio veredito de custo. */
    usdToBaseRate?: number | null;
    fallbackUsed?: boolean;
    responseText?: string;
    errorPayload?: Record<string, unknown>;
  }): Promise<void> {
    await this.decisions
      .record({
        organizationId: input.request.organizationId,
        adId: input.request.adId,
        taskType: 'creative_diagnosis',
        promptVersion: ANALYSIS_PROMPT_VERSION,
        promptHash: hashOf(input.request),
        inputDigest: input.inputDigest,
        provider: input.provider,
        model: input.model,
        outcome: input.outcome,
        latencyMs: input.latencyMs ?? 0,
        inputTokens: input.inputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        costBase: input.costBase ?? 0,
        usdToBaseRate: input.usdToBaseRate ?? null,
        fallbackUsed: input.fallbackUsed ?? false,
        correlationId: input.correlationId,
        responseText: input.responseText ?? null,
        errorPayload: input.errorPayload ?? null,
      })
      .catch((error: unknown) => {
        // A trilha falhando não pode derrubar a análise: o diagnóstico já está
        // gravado, e perder a linha de custo é menos grave que perder a resposta.
        this.logger.error(
          `ai.decision_log_failed adId=${input.request.adId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}

function hashOf(request: AnalysisNarrativeRequest): string {
  return createHash('sha256')
    .update(JSON.stringify(request))
    .digest('hex')
    .slice(0, 32);
}
