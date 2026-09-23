import { Injectable } from '@nestjs/common';

export type AIErrorCode =
  | 'capacity'
  | 'rate_limit'
  | 'timeout'
  | 'auth'
  | 'bad_request'
  | 'invalid_response'
  | 'network'
  | 'server_error'
  | 'unknown';

export type ClassifiedAIError = {
  code: AIErrorCode;
  /** Worth trying the same provider/model again. */
  retryable: boolean;
  /** Worth trying the next provider/model in the route. */
  fallbackable: boolean;
  /** HTTP status when the provider error carried one. */
  status?: number;
  /** Wait hinted by the provider via `Retry-After`, in milliseconds. */
  retryAfterMs?: number;
  message: string;
};

/** Anthropic signals "overloaded" with a non-standard 529. */
const ANTHROPIC_OVERLOADED_STATUS = 529;

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
]);

const TIMEOUT_ERROR_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT']);

@Injectable()
export class AIErrorClassifierService {
  /**
   * Provider SDKs expose a status and, on throttling, a `Retry-After` header —
   * both far more reliable than the prose in the message. Status is inspected
   * first; the string heuristics stay as the fallback for wrapped/plain errors.
   */
  classify(error: unknown): ClassifiedAIError {
    const message =
      error instanceof Error ? error.message : 'Unknown AI provider error';
    const status = this.statusOf(error);
    const retryAfterMs = this.retryAfterMsOf(error);
    const base = { status, retryAfterMs, message };

    if (status !== undefined) {
      const byStatus = this.classifyByStatus(status);

      if (byStatus) {
        return { ...base, ...byStatus };
      }
    }

    const errorCode = this.errorCodeOf(error);

    if (TIMEOUT_ERROR_CODES.has(errorCode)) {
      return { ...base, code: 'timeout', retryable: true, fallbackable: true };
    }

    if (NETWORK_ERROR_CODES.has(errorCode)) {
      return { ...base, code: 'network', retryable: true, fallbackable: true };
    }

    return { ...base, ...this.classifyByMessage(message) };
  }

  private classifyByStatus(
    status: number,
  ): Omit<ClassifiedAIError, 'message' | 'status' | 'retryAfterMs'> | null {
    if (status === 429) {
      return { code: 'rate_limit', retryable: true, fallbackable: true };
    }

    if (status === ANTHROPIC_OVERLOADED_STATUS || status === 503) {
      return { code: 'capacity', retryable: true, fallbackable: true };
    }

    if (status === 408) {
      return { code: 'timeout', retryable: true, fallbackable: true };
    }

    if (status === 401 || status === 403) {
      // A bad key will not fix itself on retry, but another provider may work.
      return { code: 'auth', retryable: false, fallbackable: true };
    }

    if (status >= 500) {
      return { code: 'server_error', retryable: true, fallbackable: true };
    }

    if (status >= 400) {
      // Our own payload is wrong — every provider would reject it the same way.
      return { code: 'bad_request', retryable: false, fallbackable: false };
    }

    return null;
  }

  private classifyByMessage(
    message: string,
  ): Omit<ClassifiedAIError, 'message' | 'status' | 'retryAfterMs'> {
    const normalized = message.toLowerCase();

    if (
      normalized.includes('capacity') ||
      normalized.includes('overloaded') ||
      normalized.includes('engine is overloaded')
    ) {
      return { code: 'capacity', retryable: true, fallbackable: true };
    }

    if (
      normalized.includes('rate limit') ||
      normalized.includes('too many requests') ||
      normalized.includes('429')
    ) {
      return { code: 'rate_limit', retryable: true, fallbackable: true };
    }

    if (
      normalized.includes('timeout') ||
      normalized.includes('timed out') ||
      normalized.includes('etimedout') ||
      normalized.includes('abort')
    ) {
      return { code: 'timeout', retryable: true, fallbackable: true };
    }

    if (
      normalized.includes('api key') ||
      normalized.includes('unauthorized') ||
      normalized.includes('authentication') ||
      normalized.includes('401') ||
      normalized.includes('403')
    ) {
      return { code: 'auth', retryable: false, fallbackable: true };
    }

    if (
      normalized.includes('invalid json') ||
      normalized.includes('non-json') ||
      normalized.includes('invalid analysis structure') ||
      // Covers the empty/unusable answer that `RoutedTextGenerationProvider`
      // raises from inside the orchestrator callback: the model replied, the
      // reply is not usable. Same verdict as a malformed one — no point asking
      // the same model again, but the next one may well answer properly.
      normalized.includes('invalid response') ||
      normalized.includes('parse')
    ) {
      return { code: 'invalid_response', retryable: false, fallbackable: true };
    }

    if (
      normalized.includes('bad request') ||
      normalized.includes('400') ||
      normalized.includes('unprocessable')
    ) {
      return { code: 'bad_request', retryable: false, fallbackable: false };
    }

    if (
      normalized.includes('network') ||
      normalized.includes('fetch failed') ||
      normalized.includes('econnreset') ||
      normalized.includes('enotfound')
    ) {
      return { code: 'network', retryable: true, fallbackable: true };
    }

    return { code: 'unknown', retryable: true, fallbackable: true };
  }

  private statusOf(error: unknown): number | undefined {
    const candidate = error as
      | {
          status?: unknown;
          statusCode?: unknown;
          response?: { status?: unknown };
        }
      | null
      | undefined;

    const raw =
      candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status;

    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  }

  private errorCodeOf(error: unknown): string {
    const raw = (error as { code?: unknown } | null | undefined)?.code;

    return typeof raw === 'string' ? raw.toUpperCase() : '';
  }

  /**
   * `Retry-After` is either a delay in seconds or an HTTP date. SDKs expose
   * headers as a plain object or as a `Headers` instance, so both are read.
   */
  private retryAfterMsOf(error: unknown): number | undefined {
    const headers = (error as { headers?: unknown } | null | undefined)
      ?.headers;

    if (!headers) return undefined;

    let raw: unknown;

    if (typeof (headers as Headers).get === 'function') {
      raw = (headers as Headers).get('retry-after');
    } else {
      const bag = headers as Record<string, unknown>;
      raw = bag['retry-after'] ?? bag['Retry-After'];
    }

    if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;

    const asSeconds = Number(raw);

    if (Number.isFinite(asSeconds) && asSeconds >= 0) {
      return Math.round(asSeconds * 1000);
    }

    const asDate = Date.parse(String(raw));

    if (Number.isNaN(asDate)) return undefined;

    return Math.max(0, asDate - Date.now());
  }
}
