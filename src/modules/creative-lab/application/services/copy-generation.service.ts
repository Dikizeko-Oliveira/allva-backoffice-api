import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { evaluateBudget } from 'src/modules/ai/domain/ai-budget';
import { costBaseOf } from 'src/modules/ai/domain/model-pricing';
import { AiBudgetReader } from 'src/modules/ai/domain/ports/ai-budget.reader';
import type { AiBudgetSettings } from 'src/modules/ai/domain/ports/ai-budget.reader';
import { AiDecisionLogRepositoryInterface } from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import type { AiCallOutcome } from 'src/modules/ai/domain/ai-budget';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import {
  monthWindow,
  retentionUntil,
  VARIANTS_PER_GENERATION,
} from 'src/modules/creative-lab/domain/copy-quota';
import { CopyGenerationsRepositoryInterface } from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import type {
  PersistVariantInput,
  StoredGeneration,
} from 'src/modules/creative-lab/domain/ports/copy-generations.repository';
import {
  CopyGenerator,
  type CopyFieldBudget,
} from 'src/modules/creative-lab/domain/ports/copy-generator.port';
import { COPY_VARIANT_REASONING_SCHEMA_VERSION } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import type { CopyGenerationContext } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** A linha do catálogo que esta cota governa. */
const FEATURE = 'copy-generation' as const;

/** A versão do motor de geração, na procedência de toda resposta (P7). */
export const COPY_ENGINE_VERSION = 'copy-v1.0.0';

/** D16 — `activePromptVersions` é um mapa **por tarefa**. */
export const COPY_PROMPT_VERSION = 'copy-generation-v1';

export type GenerateInput = {
  organizationId: string;
  accountId: string;
  adId: string;
  creativeId: string | null;
  analysisId: string | null;
  adScoreId: string | null;
  source: 'FROM_INSIGHT' | 'IMPROVE' | 'FROM_BRIEF';
  context: CopyGenerationContext;
  fieldBudgets: CopyFieldBudget[];
  /** Escape explícito do reuso: "gerar de novo" é pedido legítimo. */
  regenerate: boolean;
  correlationId: string | null;
  now?: Date;
};

export type GenerateOutcome = {
  generation: StoredGeneration;
  /** A geração veio do banco sem nova chamada de IA. */
  reused: boolean;
  quota: { limit: number | null; used: number };
};

/**
 * A geração de copy, com as três guardas na ordem que importa.
 *
 * **Plano → cota → orçamento**, e cada recusa tem um código próprio. Fundi-las
 * num "não pode" faria "seu plano não inclui" (comercial), "você usou as 20 do
 * mês" (esperar ou subir de plano) e "o teto diário de IA estourou" (voltar
 * amanhã) chegarem idênticas — três problemas com três soluções diferentes.
 *
 * **Este serviço lança, ao contrário de `AnalysisEnrichmentService`.** Lá a
 * narrativa era campo opcional sobre um diagnóstico que já estava pronto, e uma
 * exceção derrubaria a análise inteira por causa de um texto. Aqui o texto **é**
 * o pedido: cortar em silêncio devolveria uma geração vazia sem dizer por quê.
 *
 * A exceção é a falha do provider, que **não** lança: ali existe conteúdo real a
 * preservar — o contexto e as sugestões que originaram o pedido —, e é a
 * promessa da feature que a sugestão determinística sobreviva à queda da IA.
 */
@Injectable()
export class CopyGenerationService {
  private readonly logger = new Logger(CopyGenerationService.name);

  constructor(
    private readonly generator: CopyGenerator,
    private readonly generations: CopyGenerationsRepositoryInterface,
    private readonly decisions: AiDecisionLogRepositoryInterface,
    private readonly budgets: AiBudgetReader,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async generate(input: GenerateInput): Promise<GenerateOutcome> {
    const now = input.now ?? new Date();
    const inputDigest = digestOf(input.context);

    /**
     * **O reuso vem antes da cota**, e a ordem inverteu de propósito.
     *
     * Cobrar primeiro fazia quem estava no teto ser recusado ao pedir um texto
     * que já existia no banco — a pessoa perdia acesso ao que já tinha pago. É
     * a mesma regra que a análise de criativo aplica ao reuso de P9: devolver o
     * que já existe não produz nada e não consome nada.
     */
    if (!input.regenerate) {
      const previous = await this.generations.findByDigest({
        organizationId: input.organizationId,
        adId: input.adId,
        inputDigest,
      });

      /**
       * O reuso **não é P9**, e a distinção importa.
       *
       * P9 proíbe recomputo sem mudança de entrada porque o resultado seria
       * idêntico. Aqui não seria: o modelo escreve outro texto a cada chamada, e
       * pedir de novo é legítimo. Isto existe para o duplo-clique e para quem
       * reabre a tela — e tem escape explícito.
       */
      if (previous) {
        return {
          generation: previous,
          reused: true,
          quota: await this.usage(input.organizationId, now),
        };
      }
    }

    /**
     * **A reserva, e não mais uma verificação.**
     *
     * `COUNT` e depois `INSERT` liam 99 para dois pedidos simultâneos, os dois
     * passavam pelo `99 < 100`, e o mês fechava em 101 — com a tela de
     * assinatura exibindo o furo. A reserva decide e consome na mesma
     * instrução; o segundo pedido já enxerga o primeiro.
     *
     * O preço é o `catch`: a unidade sai antes do trabalho, então quem conhece
     * o desfecho tem de devolvê-la quando o trabalho não acontece.
     */
    const quota = await this.reserve(input.organizationId, now);

    try {
      const budget = await this.checkBudget(input, inputDigest, now);
      const generation = await this.callAndPersist(
        input,
        inputDigest,
        now,
        budget,
      );

      /**
       * Provider fora do ar **não consome cota**, e é por isso que a devolução
       * está aqui e não só no `catch`.
       *
       * `callAndPersist` não lança nessa falha: ela grava `AI_UNAVAILABLE` para
       * preservar o contexto e as sugestões que originaram o pedido. Se a
       * reserva ficasse de pé, o cliente pagaria uma geração que não recebeu —
       * exatamente na hora em que ele mais precisa tentar de novo.
       */
      if (generation.status !== 'COMPLETED') {
        await this.release(input.organizationId, now);

        return {
          generation,
          reused: false,
          quota: { ...quota, used: Math.max(quota.used - 1, 0) },
        };
      }

      return { generation, reused: false, quota };
    } catch (error) {
      await this.release(input.organizationId, now);
      throw error;
    }
  }

  /** O par teto/uso do mês, sem consumir — para o reuso, que não cobra. */
  private async usage(
    organizationId: string,
    now: Date,
  ): Promise<{ limit: number | null; used: number }> {
    const periodStart = monthWindow(now).since;

    const [limit, used] = await Promise.all([
      this.planEntitlement.quotaFor({ organizationId, feature: FEATURE }),
      this.planEntitlement.consumedIn({
        organizationId,
        feature: FEATURE,
        periodStart,
      }),
    ]);

    return { limit, used };
  }

  /**
   * A cota mensal — **reservada, não contada**.
   *
   * `reserveQuota` resolve o teto negociado por contrato sobre o do plano e
   * consome na mesma instrução. É o mesmo caminho de contas de anúncios e
   * anúncios monitorados para o teto, e o que impede um segundo lugar
   * respondendo "quanto esta organização pode".
   *
   * O medidor deixou de ser `COUNT` sobre `copy_generations`, e o motivo é um
   * só: aquele não era atômico. Em troca, o contador precisa de devolução
   * explícita quando o trabalho não acontece — e ganha imunidade ao expurgo de
   * 60 dias, que fazia a cota do mês encolher sozinha se a política mudasse.
   */
  private async reserve(
    organizationId: string,
    now: Date,
  ): Promise<{ limit: number | null; used: number }> {
    const window = monthWindow(now);

    const state = await this.planEntitlement.reserveQuota({
      organizationId,
      feature: FEATURE,
      periodStart: window.since,
    });

    if (state.allowed) {
      return { limit: state.limit ?? null, used: state.used ?? 0 };
    }

    throw new DomainError({
      code: 'COPY_GENERATION_QUOTA_EXCEEDED',
      // `PLAN_LIMITED` e não `NOT_PERMITTED`: o pedido é legítimo e a pessoa
      // tem a capacidade — o que acabou foi o volume do plano. É a diferença
      // entre "você não pode" e "você já usou", e só a segunda tem caminho
      // comercial.
      category: 'PLAN_LIMITED',
      message:
        `Você usou as ${state.quota?.limit ?? state.used ?? 0} gerações de ` +
        `copy deste mês no plano ${state.planLabel}.`,
      details: {
        used: state.quota?.used ?? state.used ?? 0,
        limit: state.quota?.limit ?? null,
        resetsAt: window.until.toISOString(),
        upgradeTo: state.upgradeTo,
      },
      remediation: state.upgradeTo
        ? `A cota volta em ${window.until.toISOString().slice(0, 10)}. ` +
          `O plano ${state.upgradeTo} oferece mais gerações por mês.`
        : `A cota volta em ${window.until.toISOString().slice(0, 10)}. ` +
          'Para um teto maior, fale com o comercial.',
    });
  }

  /** Devolve a reserva de uma geração que não chegou a existir. */
  private async release(organizationId: string, now: Date): Promise<void> {
    await this.planEntitlement.releaseQuota({
      organizationId,
      feature: FEATURE,
      periodStart: monthWindow(now).since,
    });
  }

  /**
   * C9 — o teto diário de gasto, que continua sendo a parede.
   *
   * Convive com a cota mensal porque os dois medem coisas diferentes: a cota
   * governa **quantas vezes** se pede, este governa **quanto dinheiro** sai por
   * dia. Um pedido dentro da cota mensal ainda pode cair aqui, e o código de
   * recusa diz qual dos dois foi.
   */
  private async checkBudget(
    input: GenerateInput,
    inputDigest: string,
    now: Date,
  ): Promise<AiBudgetSettings> {
    const budget = await this.budgets.budgetFor(input.organizationId);
    const spentBase = await this.decisions.spentTodayBase({
      organizationId: input.organizationId,
      day: now,
    });

    const verdict = evaluateBudget({
      spentBase,
      limitBase: budget.llmDailyBudgetBase,
      // Estimativa nula = não sabemos precificar nesta moeda-base. Projetar zero
      // faz o teto não se aplicar, que é a degradação honesta: o custo real
      // também não poderá ser gravado.
      estimatedCostBase: budget.estimatedCallCostBase ?? 0,
    });

    // Devolvido em vez de relido depois: são a mesma pergunta na mesma
    // requisição, e duas leituras podem discordar se a moeda-base da
    // organização mudar entre elas.
    if (verdict.allowed) return budget;

    // Corte registrado: em silêncio, "sumiu a geração" e "o provider caiu"
    // ficam indistinguíveis para quem investiga.
    await this.record(input, inputDigest, {
      outcome: 'SKIPPED_BUDGET',
      provider: 'none',
      model: 'none',
    });

    this.logger.warn(
      `ai.skipped_budget task=creative_suggestion organizationId=${input.organizationId} ` +
        `gasto=${verdict.spentBase} teto=${verdict.limitBase}`,
    );

    throw new DomainError({
      code: 'AI_DAILY_BUDGET_EXHAUSTED',
      /**
       * `RATE_LIMITED` — 429 e **retentável**, ao contrário da cota mensal.
       *
       * O teto diário reabre amanhã sem ninguém fazer nada, e é a categoria que
       * diz isso ao cliente HTTP. Um 403 convidaria a tratar como permissão
       * ausente e a esconder o botão para sempre.
       */
      category: 'RATE_LIMITED',
      message:
        'O teto diário de IA desta organização foi atingido: nenhuma geração ' +
        'nova sai hoje.',
      details: { spentBase: verdict.spentBase, limitBase: verdict.limitBase },
      remediation:
        'O teto reabre amanhã. A análise e as sugestões continuam disponíveis.',
    });
  }

  /**
   * A chamada e a persistência — **e a falha do provider não lança**.
   *
   * É a única das três guardas que produz linha em vez de erro, porque é a única
   * em que existe conteúdo real a preservar: o contexto e as sugestões que
   * originaram o pedido continuam valendo, e a promessa da feature é exatamente
   * que a sugestão determinística sobreviva à queda da IA.
   */
  private async callAndPersist(
    input: GenerateInput,
    inputDigest: string,
    now: Date,
    budget: AiBudgetSettings,
  ): Promise<StoredGeneration> {
    const startedAt = Date.now();

    try {
      const generated = await this.generator.generate({
        organizationId: input.organizationId,
        adId: input.adId,
        source: input.source,
        context: input.context,
        fieldBudgets: input.fieldBudgets,
        variantCount: VARIANTS_PER_GENERATION,
      });

      await this.record(input, inputDigest, {
        outcome: 'SUCCEEDED',
        provider: generated.provider,
        model: generated.model,
        latencyMs: Date.now() - startedAt,
        inputTokens: generated.inputTokens,
        outputTokens: generated.outputTokens,
        ...this.costOf(generated, budget),
        fallbackUsed: generated.fallbackUsed,
      });

      return this.generations.persist({
        ...this.persistBase(input, inputDigest, now),
        status: 'COMPLETED',
        aiProvider: generated.provider,
        aiModel: generated.model,
        failureReason: null,
        variants: generated.variants.map(toVariant),
      });
    } catch (error) {
      const failure = describeFailure(error);

      await this.record(input, inputDigest, {
        outcome: 'FAILED',
        provider: 'unknown',
        model: 'unknown',
        latencyMs: Date.now() - startedAt,
        errorPayload: failure,
      });

      this.logger.warn(
        `ai.copy_generation_failed adId=${input.adId}: ${failure.message} ` +
          `[${(failure.attempts ?? []).join(' | ')}] — sugestão preservada`,
      );

      return this.generations.persist({
        ...this.persistBase(input, inputDigest, now),
        status: 'AI_UNAVAILABLE',
        aiProvider: null,
        aiModel: null,
        /**
         * O motivo é interno e **não vai para a tela como está**: ele pode
         * carregar mensagem de provider. Quem apresenta traduz para uma frase
         * que a pessoa entende, e este campo fica para quem investiga.
         */
        failureReason: [failure.message, ...(failure.attempts ?? [])]
          .join(' | ')
          .slice(0, 500),
        variants: [],
      });
    }
  }

  /**
   * O custo em moeda-base — e **nunca lança**.
   *
   * A contabilidade acontece depois de a chamada ter sido paga e o texto já
   * existir. Uma exceção aqui cairia no `catch` de cima e transformaria uma
   * geração bem-sucedida em `AI_UNAVAILABLE`: a organização pagaria pelos
   * tokens e perderia as variações por causa de uma taxa de câmbio mal
   * configurada.
   *
   * A degradação é `costBase: null` com aviso — o mesmo desfecho que
   * `CURRENCY_NOT_CONVERTIBLE` já produz por caminho normal, e que o teto
   * diário sabe tratar.
   */
  private costOf(
    generated: {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
    },
    budget: AiBudgetSettings,
  ): { costBase: number | null; usdToBaseRate: number | null } {
    try {
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

      // A taxa acompanha o custo, do mesmo veredito: relê-la na hora de gravar
      // poderia carimbar um câmbio que não foi o usado.
      return { costBase: cost.costBase, usdToBaseRate: cost.usdToBaseRate };
    } catch (error) {
      this.logger.error(
        `ai.cost_computation_failed ${generated.provider}/${generated.model}: ${
          error instanceof Error ? error.message : String(error)
        } — geração preservada, custo não contabilizado`,
      );

      return { costBase: null, usdToBaseRate: null };
    }
  }

  private persistBase(input: GenerateInput, inputDigest: string, now: Date) {
    return {
      organizationId: input.organizationId,
      accountId: input.accountId,
      adId: input.adId,
      creativeId: input.creativeId,
      analysisId: input.analysisId,
      adScoreId: input.adScoreId,
      source: input.source,
      context: input.context,
      inputDigest,
      engineVersion: COPY_ENGINE_VERSION,
      promptVersion: COPY_PROMPT_VERSION,
      retentionUntil: retentionUntil(now),
    };
  }

  /**
   * A trilha de C9 — **inclusive quando não houve chamada**.
   *
   * `responseText` fica de fora de propósito: o texto gerado já mora em
   * `copy_variants`, que é onde ele é ativo do cliente. Duplicá-lo aqui criaria
   * uma segunda cópia de conteúdo de marca numa tabela cuja política é retenção
   * curta — e as duas divergiriam no primeiro expurgo.
   */
  private async record(
    input: GenerateInput,
    inputDigest: string,
    outcome: {
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
      errorPayload?: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.decisions
      .record({
        organizationId: input.organizationId,
        adId: input.adId,
        taskType: 'creative_suggestion',
        promptVersion: COPY_PROMPT_VERSION,
        promptHash: inputDigest,
        inputDigest,
        provider: outcome.provider,
        model: outcome.model,
        outcome: outcome.outcome,
        latencyMs: outcome.latencyMs ?? 0,
        inputTokens: outcome.inputTokens ?? 0,
        outputTokens: outcome.outputTokens ?? 0,
        costBase: outcome.costBase ?? 0,
        usdToBaseRate: outcome.usdToBaseRate ?? null,
        fallbackUsed: outcome.fallbackUsed ?? false,
        correlationId: input.correlationId,
        responseText: null,
        errorPayload: outcome.errorPayload ?? null,
      })
      .catch((error: unknown) => {
        // Perder a linha de custo é menos grave que perder a geração.
        this.logger.error(
          `ai.decision_log_failed adId=${input.adId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}

function toVariant(variant: {
  angle: PersistVariantInput['angle'];
  hook: string | null;
  primaryText: string | null;
  headline: string | null;
  description: string | null;
  callToAction: string | null;
  reasoning: { claim: string; addressesSuggestion: string | null }[];
}): PersistVariantInput {
  return {
    angle: variant.angle,
    hook: variant.hook,
    primaryText: variant.primaryText,
    headline: variant.headline,
    description: variant.description,
    callToAction: variant.callToAction,
    reasoning: {
      schemaVersion: COPY_VARIANT_REASONING_SCHEMA_VERSION,
      points: variant.reasoning,
    },
  };
}

/**
 * O que de fato aconteceu na rota — **candidato a candidato**.
 *
 * `AIOrchestratorService` coleta o erro de cada tentativa e os entrega em
 * `details` da exceção. Ler só `.message` deixava a trilha com "All AI providers
 * failed" e nada mais: verdadeiro, e inútil para quem investiga — não diz se
 * foram três 401, três respostas fora do contrato ou um timeout seguido de dois
 * cooldowns, e essas três causas pedem três correções diferentes.
 *
 * Foi um defeito encontrado exercitando a feature contra provedores reais: a
 * geração degradou corretamente e o motivo se perdeu.
 */
function describeFailure(error: unknown): {
  message: string;
  attempts?: string[];
} {
  const message = error instanceof Error ? error.message : String(error);

  if (typeof (error as { getResponse?: unknown })?.getResponse !== 'function') {
    return { message };
  }

  const response = (error as { getResponse: () => unknown }).getResponse() as {
    details?: unknown;
  };

  return Array.isArray(response?.details)
    ? { message, attempts: response.details.map((item) => String(item)) }
    : { message };
}

/**
 * O dígito do **contexto**, não do prompt montado.
 *
 * O prompt é derivado: mudar uma palavra da instrução mudaria o dígito sem que
 * nada sobre o anúncio tivesse mudado, e o reuso pararia de funcionar a cada
 * ajuste de redação. O contexto é o que de fato descreve o pedido.
 */
function digestOf(context: CopyGenerationContext): string {
  return createHash('sha256')
    .update(JSON.stringify(context))
    .digest('hex')
    .slice(0, 32);
}
