import { Injectable, Logger } from '@nestjs/common';
import {
  ClassifiedPlatformError,
  backoffDelayMs,
  classifyPlatformError,
} from '../domain/platform-error';
import { PlatformRateLimiterService } from './platform-rate-limiter.service';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type PlatformRequest = {
  /** A integração cujo orçamento de chamadas esta requisição consome. */
  integrationId: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
};

export type PlatformResponse<T> = {
  data: T;
  status: number;
  attempts: number;
};

export class PlatformRequestError extends Error {
  constructor(
    readonly classified: ClassifiedPlatformError,
    readonly attempts: number,
  ) {
    super(classified.message);
    this.name = 'PlatformRequestError';
  }
}

/**
 * Transporte compartilhado por plataforma (§5.2).
 *
 * ISP separa os gateways de leitura e escrita, e isso está certo — mas ISP se
 * aplica ao **contrato**, não ao **transporte**. Leitura e escrita da mesma
 * plataforma compartilham credencial, refresh de token, orçamento de chamadas e
 * semântica de erro; mantê-los em módulos que não podem se importar é o que
 * torna o token bucket de R4 impossível de implementar.
 *
 * Três coisas acontecem aqui e em nenhum provider: o balde de tokens, a
 * classificação de erro por status e o backoff com jitter que respeita
 * `Retry-After`.
 */
@Injectable()
export class PlatformHttpClient {
  private readonly logger = new Logger(PlatformHttpClient.name);

  constructor(private readonly rateLimiter: PlatformRateLimiterService) {}

  async request<T>(request: PlatformRequest): Promise<PlatformResponse<T>> {
    const maxAttempts = request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    let lastError: ClassifiedPlatformError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const budget = this.rateLimiter.tryAcquire(request.integrationId);
      if (!budget.allowed) {
        // Esperar é o comportamento correto: insistir queima a cota que o balde
        // existe para proteger.
        await sleep(budget.retryAfterMs);
      }

      try {
        return await this.send<T>(request, attempt);
      } catch (error) {
        lastError =
          error instanceof PlatformRequestError
            ? error.classified
            : classifyPlatformError({
                message: error instanceof Error ? error.message : String(error),
              });

        if (!lastError.retryable || attempt === maxAttempts) {
          throw new PlatformRequestError(lastError, attempt);
        }

        const delay = backoffDelayMs({
          attempt,
          retryAfterMs: lastError.retryAfterMs,
        });
        this.logger.warn(
          `platform.retry integrationId=${request.integrationId} tentativa=${attempt} code=${lastError.code} espera=${delay}ms`,
        );
        await sleep(delay);
      }
    }

    throw new PlatformRequestError(
      lastError ??
        classifyPlatformError({ message: 'Falha sem classificação' }),
      maxAttempts,
    );
  }

  private async send<T>(
    request: PlatformRequest,
    attempt: number,
  ): Promise<PlatformResponse<T>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    try {
      const response = await fetch(request.url, {
        method: request.method ?? 'GET',
        headers: {
          'content-type': 'application/json',
          ...(request.headers ?? {}),
        },
        body: request.body ? JSON.stringify(request.body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new PlatformRequestError(
          classifyPlatformError({
            status: response.status,
            retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
            message: `HTTP ${response.status} em ${request.url}`,
          }),
          attempt,
        );
      }

      return {
        data: (await response.json()) as T,
        status: response.status,
        attempts: attempt,
      };
    } catch (error) {
      if (error instanceof PlatformRequestError) throw error;

      const code =
        error instanceof Error && 'code' in error
          ? String((error as { code: unknown }).code)
          : error instanceof Error && error.name === 'AbortError'
            ? 'ABORT_ERR'
            : undefined;

      throw new PlatformRequestError(
        classifyPlatformError({
          errorCode: code,
          message: error instanceof Error ? error.message : String(error),
        }),
        attempt,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** `Retry-After` vem em segundos ou como data HTTP; as duas formas contam. */
export function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.round(seconds * 1000);

  const date = Date.parse(header);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - Date.now());
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
