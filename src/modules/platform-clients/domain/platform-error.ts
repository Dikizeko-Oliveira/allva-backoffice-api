/**
 * Classificação de erro de plataforma, por status HTTP primeiro.
 *
 * Generalizado de `ai/infrastructure/routing/ai-error-classifier.service.ts`,
 * que já faz isso bem (Apêndice C): status é evidência, a prosa da mensagem é
 * heurística — e as três plataformas escrevem prosa diferente para a mesma
 * condição.
 */
export type PlatformErrorCode =
  | 'rate_limit'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'bad_request'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'unknown';

export type ClassifiedPlatformError = {
  code: PlatformErrorCode;
  /** Vale tentar de novo o mesmo pedido. */
  retryable: boolean;
  status?: number;
  /** Espera pedida pela plataforma via `Retry-After`, em milissegundos. */
  retryAfterMs?: number;
  message: string;
};

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

export function classifyPlatformError(input: {
  status?: number;
  retryAfterMs?: number;
  errorCode?: string;
  message?: string;
}): ClassifiedPlatformError {
  const message = input.message ?? 'Erro desconhecido de plataforma';
  const base = {
    status: input.status,
    retryAfterMs: input.retryAfterMs,
    message,
  };

  if (input.errorCode && NETWORK_ERROR_CODES.has(input.errorCode)) {
    return { ...base, code: 'network', retryable: true };
  }
  if (input.errorCode === 'ETIMEDOUT' || input.errorCode === 'ABORT_ERR') {
    return { ...base, code: 'timeout', retryable: true };
  }

  const status = input.status;
  if (status === undefined)
    return { ...base, code: 'unknown', retryable: false };

  if (status === 429) return { ...base, code: 'rate_limit', retryable: true };
  if (status === 401) return { ...base, code: 'auth', retryable: false };
  if (status === 403) return { ...base, code: 'permission', retryable: false };
  if (status === 404) return { ...base, code: 'not_found', retryable: false };
  if (status === 408) return { ...base, code: 'timeout', retryable: true };
  if (status >= 500) return { ...base, code: 'server_error', retryable: true };
  if (status >= 400) return { ...base, code: 'bad_request', retryable: false };

  return { ...base, code: 'unknown', retryable: false };
}

/**
 * Backoff exponencial **com jitter**.
 *
 * O jitter não é refinamento: sem ele, N workers que tomaram 429 na mesma janela
 * voltam juntos no mesmo milissegundo e tomam 429 de novo, em fase — a plataforma
 * vê uma rajada periódica em vez de uma retomada gradual.
 *
 * `Retry-After` da plataforma sempre vence: ela sabe quando volta a aceitar.
 */
export function backoffDelayMs(input: {
  attempt: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryAfterMs?: number;
  random?: () => number;
}): number {
  if (input.retryAfterMs && input.retryAfterMs > 0) return input.retryAfterMs;

  const base = input.baseDelayMs ?? 500;
  const max = input.maxDelayMs ?? 60_000;
  const random = input.random ?? Math.random;

  const exponential = Math.min(max, base * 2 ** Math.max(0, input.attempt - 1));
  // Jitter completo: qualquer ponto entre 0 e o teto exponencial.
  return Math.round(exponential * random());
}
