import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AIErrorClassifierService,
  ClassifiedAIError,
} from './ai-error-classifier.service';
import { AITaskType, ModelCandidate } from './ai-task.types';
import { ModelRouterService } from './model-router.service';
import { ProviderHealthRegistry } from './provider-health.registry';
import type { AIProviderType } from './ai-task.types';

type OrchestratorRunInput<T> = {
  task: AITaskType;
  execute: (candidate: ModelCandidate) => Promise<T>;
  canUseCandidate?: (candidate: ModelCandidate) => boolean;
};

export type OrchestratorRunOutput<T> = {
  result: T;
  /**
   * O candidato que **de fato** atendeu, já depois de eventuais quedas na rota.
   *
   * Tipado como `AIProviderType` e não `string`: quem consome grava isso em
   * `AIDecisionLog` e compara custo por provedor, e um `string` solto deixaria
   * passar um 'routed' ou um 'unknown' — que foi exatamente o que ficou gravado
   * nas primeiras 881 chamadas.
   */
  provider: AIProviderType;
  model: string;
  /**
   * O vencedor **não** era o primeiro da rota.
   *
   * Derivado da posição, e não comparado com o preferido pelo consumidor: só o
   * orquestrador sabe quais candidatos foram descartados por falta de
   * credencial ou por estarem em cooldown de saúde, e uma régua montada fora
   * dele acusaria fallback onde houve rota normal.
   */
  fallbackUsed: boolean;
};

/** Attempts against a single candidate before moving down the route. */
const MAX_ATTEMPTS_PER_CANDIDATE = 2;
const BASE_BACKOFF_MS = 500;
/**
 * Longest we are willing to sit waiting between attempts. A provider asking for
 * more than this is not worth waiting on inside a request — switching providers
 * is faster, and the registry parks it for the full duration it asked for.
 */
const MAX_BACKOFF_MS = 4_000;

@Injectable()
export class AIOrchestratorService {
  private readonly logger = new Logger(AIOrchestratorService.name);

  constructor(
    private readonly modelRouter: ModelRouterService,
    private readonly errorClassifier: AIErrorClassifierService,
    private readonly health: ProviderHealthRegistry,
  ) {}

  async run<T>(
    input: OrchestratorRunInput<T>,
  ): Promise<OrchestratorRunOutput<T>> {
    const route = this.routeFor(input);
    const errors: string[] = [];

    for (const [index, candidate] of route.entries()) {
      const outcome = await this.runCandidate(candidate, input, errors);

      if (outcome.status === 'ok') {
        this.health.reportSuccess(candidate);

        return {
          result: outcome.result,
          provider: candidate.provider,
          model: candidate.model,
          fallbackUsed: index > 0,
        };
      }

      if (outcome.status === 'abort') {
        throw outcome.error;
      }
    }

    throw new ServiceUnavailableException({
      code: 'AI_ORCHESTRATION_FAILED',
      message: `All AI providers failed for task ${input.task}`,
      details: errors,
    });
  }

  /**
   * Candidates the caller allows, minus the ones currently cooling down. If the
   * filter empties the route we ignore the cooldowns and try anyway — a stale
   * cooldown must never turn into a hard outage.
   */
  private routeFor<T>(input: OrchestratorRunInput<T>): ModelCandidate[] {
    const allowed = this.modelRouter
      .getCandidates(input.task)
      .filter((candidate) => input.canUseCandidate?.(candidate) ?? true);

    const healthy = allowed.filter((candidate) => {
      const remaining = this.health.cooldownRemainingMs(candidate);

      if (remaining > 0) {
        this.logger.log(
          `Skipping ${candidate.provider}/${candidate.model} for ${input.task}: cooling down for ${remaining}ms`,
        );
      }

      return remaining === 0;
    });

    if (healthy.length > 0) return healthy;

    this.logger.warn(
      `Every candidate for ${input.task} is cooling down; trying the full route anyway`,
    );

    return allowed;
  }

  private async runCandidate<T>(
    candidate: ModelCandidate,
    input: OrchestratorRunInput<T>,
    errors: string[],
  ): Promise<
    | { status: 'ok'; result: T }
    | { status: 'next' }
    | { status: 'abort'; error: unknown }
  > {
    // The in-memory fallback cannot fail transiently, so retrying it is waste.
    const maxAttempts =
      candidate.provider === 'memory' ? 1 : MAX_ATTEMPTS_PER_CANDIDATE;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.logger.log(
          `AI task ${input.task} using ${candidate.provider}/${candidate.model} attempt ${attempt}`,
        );

        return { status: 'ok', result: await input.execute(candidate) };
      } catch (error) {
        const classified = this.errorClassifier.classify(error);

        this.health.reportFailure(candidate, classified);
        errors.push(this.summarize(candidate, classified));
        this.logger.warn(
          `AI task ${input.task} failed: ${this.summarize(candidate, classified)}`,
        );

        if (!classified.fallbackable) {
          return { status: 'abort', error };
        }

        const backoff = this.backoffMs(attempt, classified);

        if (attempt < maxAttempts && classified.retryable && backoff !== null) {
          await this.sleep(backoff);
          continue;
        }

        return { status: 'next' };
      }
    }

    return { status: 'next' };
  }

  private summarize(
    candidate: ModelCandidate,
    error: ClassifiedAIError,
  ): string {
    const status = error.status === undefined ? '' : ` status=${error.status}`;

    return `${candidate.provider}/${candidate.model} [${error.code}]${status} ${error.message}`;
  }

  /**
   * Honours `Retry-After` when the provider sent one, otherwise exponential
   * backoff with jitter so parallel workers do not retry in lockstep. Returns
   * null when the wait is too long to be worth it — the caller then falls
   * straight through to the next provider.
   */
  private backoffMs(attempt: number, error: ClassifiedAIError): number | null {
    if (error.retryAfterMs !== undefined) {
      return error.retryAfterMs > MAX_BACKOFF_MS ? null : error.retryAfterMs;
    }

    const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = Math.random() * exponential * 0.5;

    return Math.min(Math.round(exponential + jitter), MAX_BACKOFF_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
