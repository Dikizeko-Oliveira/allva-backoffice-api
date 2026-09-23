import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TextGenerationProviderInterface } from 'src/modules/ai/contracts/text-generation-provider.contract';
import { AiBudgetReader } from 'src/modules/ai/domain/ports/ai-budget.reader';
import { AiDecisionLogRepositoryInterface } from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import { evaluateBudget } from 'src/modules/ai/domain/ai-budget';
import {
  DailyDigestNarrator,
  type DigestNarrationResult,
} from 'src/modules/analytics/domain/ports/daily-digest.narrator';
import type { DigestFacts } from 'src/modules/analytics/domain/daily-digest';

/** D16 — a versão do prompt viaja com o texto que ela produziu. */
const PROMPT_VERSION = 'daily-digest-1.0.0';

const SYSTEM_PROMPT = [
  'Você resume o desempenho de mídia paga de uma conta, em português do Brasil.',
  'Escreva 2 a 3 frases, no máximo 400 caracteres.',
  'Termine sempre a última frase — texto cortado no meio é pior que texto curto.',
  'REGRA ABSOLUTA: use apenas os números fornecidos. Nunca invente métrica,',
  'percentual, nome de campanha ou causa que não esteja nos dados.',
  'Se um dado não foi fornecido, não fale sobre ele.',
  'Não dê ordens ("faça X"); descreva o que aconteceu e o que chama atenção.',
].join(' ');

function buildUserPrompt(facts: DigestFacts): string {
  const money = (value: number | null) =>
    value === null
      ? 'indisponível'
      : `${value.toFixed(2)} ${facts.baseCurrency ?? ''}`.trim();

  return [
    `Janela: últimos ${facts.periodDays} dias.`,
    `Investimento: ${money(facts.spendBase)}.`,
    `Receita: ${money(facts.revenueBase)}.`,
    `ROAS: ${facts.roas === null ? 'indisponível' : `${facts.roas.toFixed(2)}x`}.`,
    facts.spendDelta === null
      ? 'Variação de investimento: sem base de comparação.'
      : `Variação de investimento vs. período anterior: ${facts.spendDelta.toFixed(0)}%.`,
    facts.roasDelta === null
      ? 'Variação de ROAS: sem base de comparação.'
      : `Variação de ROAS vs. período anterior: ${facts.roasDelta.toFixed(0)}%.`,
    `Achados de desperdício abertos: ${facts.openWasteCount}, em ${facts.affectedAds} anúncio(s).`,
    `Valor evitável por dia: ${money(facts.avoidableDailyBase)}.`,
  ].join(' ');
}

/**
 * O narrador do resumo diário.
 *
 * **Recebe fatos e devolve texto** — não tem acesso a repositório nenhum, e é
 * essa assinatura que torna P4 verificável: não há como este objeto inventar um
 * número, porque não tem de onde tirar um.
 *
 * Nunca lança. Uma exceção aqui derrubaria o job de resumo de uma organização
 * inteira por causa de um texto que é, por contrato, opcional.
 */
@Injectable()
export class RoutedDailyDigestNarrator extends DailyDigestNarrator {
  private readonly logger = new Logger(RoutedDailyDigestNarrator.name);

  constructor(
    private readonly text: TextGenerationProviderInterface,
    private readonly budgets: AiBudgetReader,
    private readonly decisions: AiDecisionLogRepositoryInterface,
  ) {
    super();
  }

  async narrate(input: {
    organizationId: string;
    facts: DigestFacts;
    inputDigest: string;
    correlationId: string | null;
  }): Promise<DigestNarrationResult> {
    const userPrompt = buildUserPrompt(input.facts);
    const promptHash = createHash('sha256').update(userPrompt).digest('hex');

    const budget = await this.budgets.budgetFor(input.organizationId);
    const spentBase = await this.decisions.spentTodayBase({
      organizationId: input.organizationId,
      day: new Date(),
    });

    const verdict = evaluateBudget({
      spentBase,
      limitBase: budget.llmDailyBudgetBase,
      // Estimativa nula = sem como precificar nesta moeda-base: o teto deixa de
      // se aplicar, coerente com o custo real também não poder ser gravado.
      estimatedCostBase: budget.estimatedCallCostBase ?? 0,
    });

    // C9 — o teto corta antes da chamada, e o corte fica registrado: cortar em
    // silêncio tornaria "o resumo veio sem IA" e "o provider caiu"
    // indistinguíveis para quem investiga a conta no fim do mês.
    if (!verdict.allowed) {
      await this.record(input, promptHash, 'SKIPPED_BUDGET', 'none', 'none');

      this.logger.warn(
        `ai.skipped_budget task=daily_digest organizationId=${input.organizationId} ` +
          `gasto=${verdict.spentBase} teto=${verdict.limitBase}`,
      );

      return {
        narrative: null,
        provider: null,
        model: null,
        promptVersion: null,
        outcome: 'SKIPPED_BUDGET',
      };
    }

    const startedAt = Date.now();

    try {
      const generated = await this.text.generateText({
        task: 'daily_digest',
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxCharacters: 400,
      });

      await this.record(
        input,
        promptHash,
        'SUCCEEDED',
        generated.provider,
        generated.model,
        Date.now() - startedAt,
        generated.text,
      );

      return {
        narrative: generated.text,
        provider: generated.provider,
        model: generated.model,
        promptVersion: PROMPT_VERSION,
        outcome: 'SUCCEEDED',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await this.record(
        input,
        promptHash,
        'FAILED',
        'unknown',
        'unknown',
        Date.now() - startedAt,
      );

      // P4: campo nulo, resto intacto. O resumo determinístico assume.
      this.logger.warn(
        `ai.digest_failed organizationId=${input.organizationId}: ${message} — resumo determinístico assume`,
      );

      return {
        narrative: null,
        provider: null,
        model: null,
        promptVersion: null,
        outcome: 'FAILED',
      };
    }
  }

  private async record(
    input: {
      organizationId: string;
      inputDigest: string;
      correlationId: string | null;
    },
    promptHash: string,
    outcome: 'SUCCEEDED' | 'FAILED' | 'SKIPPED_BUDGET',
    provider: string,
    model: string,
    latencyMs?: number,
    responseText?: string,
  ): Promise<void> {
    await this.decisions.record({
      organizationId: input.organizationId,
      taskType: 'DAILY_DIGEST',
      provider,
      model,
      promptVersion: PROMPT_VERSION,
      outcome,
      fallbackUsed: false,
      inputDigest: input.inputDigest,
      promptHash,
      latencyMs: latencyMs ?? null,
      responseText: responseText ?? null,
      correlationId: input.correlationId,
    });
  }
}
