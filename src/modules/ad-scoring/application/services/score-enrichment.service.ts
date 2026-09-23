import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AiCallOutcome } from 'src/modules/ai/domain/ai-budget';
import { AiBudgetReader } from 'src/modules/ai/domain/ports/ai-budget.reader';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { AiDecisionLogRepositoryInterface } from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import { evaluateBudget } from 'src/modules/ai/domain/ai-budget';
import { costBaseOf } from 'src/modules/ai/domain/model-pricing';
import {
  AdNarrativeGenerator,
  type AdNarrativeRequest,
} from 'src/modules/ad-scoring/domain/ports/ad-narrative.generator';

export type EnrichmentResult = {
  /** `null` sempre que a IA não pôde ou não deveria falar. Nunca uma desculpa. */
  narrative: string | null;
  provider: string | null;
  model: string | null;
  outcome: AiCallOutcome;
};

/**
 * O enriquecimento por IA do score (§12.6, P4, C9).
 *
 * **P4 é a regra que este serviço existe para não violar:** determinístico
 * primeiro, IA por cima. O score já foi calculado e persistido antes de qualquer
 * coisa aqui acontecer; a narrativa é um campo a mais. Falha de provider,
 * orçamento estourado, chave ausente — todos produzem `narrative: null` e
 * **nada mais muda**. O produto continua inteiro sem uma única chamada de LLM.
 *
 * Por isso este serviço nunca lança. Uma exceção subindo daqui derrubaria o
 * ciclo de scoring de uma conta inteira por causa de um texto opcional.
 */
@Injectable()
export class ScoreEnrichmentService {
  private readonly logger = new Logger(ScoreEnrichmentService.name);

  constructor(
    private readonly generator: AdNarrativeGenerator,
    private readonly decisions: AiDecisionLogRepositoryInterface,
    private readonly budgets: AiBudgetReader,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async enrich(input: {
    organizationId: string;
    adId: string;
    request: AdNarrativeRequest;
    inputDigest: string;
    correlationId: string | null;
    now?: Date;
  }): Promise<EnrichmentResult> {
    const now = input.now ?? new Date();
    const promptHash = hashOf(input.request);

    /**
     * O plano decide **antes** do orçamento, e o desfecho registrado é outro.
     *
     * Um plano sem narrativas não é um teto atingido: a chamada nunca foi
     * oferecida. Gravar `SKIPPED_BUDGET` aqui faria a análise de custo contar
     * como limite excedido o que nunca foi tentado, e mandaria quem investiga
     * "por que sumiu a narrativa?" procurar um orçamento que ninguém estourou.
     *
     * P4 continua valendo do mesmo jeito: o score já está calculado e persistido,
     * e a ausência de narrativa não muda mais nada.
     */
    if (
      !(await this.planEntitlement.allows({
        organizationId: input.organizationId,
        feature: 'ai-narratives',
      }))
    ) {
      await this.record({
        input,
        promptHash,
        outcome: 'SKIPPED_PLAN',
        provider: 'none',
        model: 'none',
      });

      return {
        narrative: null,
        provider: null,
        model: null,
        outcome: 'SKIPPED_PLAN',
      };
    }

    const budget = await this.budgets.budgetFor(input.organizationId);
    const spentBase = await this.decisions.spentTodayBase({
      organizationId: input.organizationId,
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

    // C9: estourar o teto **pula o enriquecimento** e registra o corte. A
    // alternativa — cortar em silêncio — tornaria "a narrativa sumiu" e "o
    // provider está fora do ar" indistinguíveis para quem investiga.
    if (!verdict.allowed) {
      await this.record({
        input,
        promptHash,
        outcome: 'SKIPPED_BUDGET',
        provider: 'none',
        model: 'none',
      });

      this.logger.warn(
        `ai.skipped_budget organizationId=${input.organizationId} ` +
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
      const generated = await this.generator.generate(input.request);
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
          `ai.cost_not_priced organizationId=${input.organizationId} ` +
            `moedaBase=${budget.pricing.baseCurrency} — teto diário sem efeito`,
        );
      }

      await this.record({
        input,
        promptHash,
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
        input,
        promptHash,
        outcome: 'FAILED',
        provider: 'unknown',
        model: 'unknown',
        latencyMs: Date.now() - startedAt,
        errorPayload: { message },
      });

      // **P4**: campo nulo, resto intacto. Nunca relança.
      this.logger.warn(
        `ai.narrative_failed adId=${input.adId}: ${message} — score preservado`,
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
   * O registro nunca derruba o que descreve.
   *
   * Mesmo raciocínio do `AuditLogService`: uma linha de contabilidade que falha
   * é degradação; uma exceção aqui apagaria a narrativa que já foi gerada e
   * paga.
   */
  private async record(args: {
    input: {
      organizationId: string;
      adId: string;
      inputDigest: string;
      correlationId: string | null;
    };
    promptHash: string;
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
    try {
      await this.decisions.record({
        organizationId: args.input.organizationId,
        adId: args.input.adId,
        taskType: 'AD_NARRATIVE',
        provider: args.provider,
        model: args.model,
        promptVersion: NARRATIVE_PROMPT_VERSION,
        outcome: args.outcome,
        fallbackUsed: args.fallbackUsed ?? false,
        inputTokens: args.inputTokens ?? null,
        outputTokens: args.outputTokens ?? null,
        latencyMs: args.latencyMs ?? null,
        costBase: args.costBase ?? null,
        usdToBaseRate: args.usdToBaseRate ?? null,
        inputDigest: args.input.inputDigest,
        promptHash: args.promptHash,
        // Texto de resposta contém conteúdo de marca do cliente: fica de fora
        // por padrão, e o hash é o que sustenta a auditoria.
        responseText: null,
        errorPayload: args.errorPayload ?? null,
        correlationId: args.input.correlationId,
      });
    } catch (error) {
      this.logger.error(
        `ai.decision_log_failed adId=${args.input.adId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * A versão do prompt, gravada em cada chamada.
 *
 * `OrganizationAdsSettings.activePromptVersions` é um mapa **por tarefa** (D16):
 * narrativa, sugestão criativa e título de recomendação evoluem em ritmos
 * diferentes, e uma versão global obrigaria a subir as três para mexer numa.
 */
export const NARRATIVE_PROMPT_VERSION = 'ad-narrative-v1';

function hashOf(request: AdNarrativeRequest): string {
  return createHash('sha256').update(JSON.stringify(request)).digest('hex');
}
