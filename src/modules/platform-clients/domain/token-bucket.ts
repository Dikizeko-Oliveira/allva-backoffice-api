/**
 * Token bucket puro — o limitador que existe por integração (R4).
 *
 * **É a razão de `platform-clients` existir.** Leitura e escrita da mesma
 * plataforma compartilham credencial e orçamento de chamadas: se cada uma
 * contasse o seu, o limite real seria a soma dos dois e a plataforma cortaria a
 * conta inteira — inclusive as escritas, que são as que movem dinheiro.
 *
 * Sem estado global e sem timer: o tempo entra como argumento. É o que torna o
 * comportamento sob rajada testável sem `jest.useFakeTimers()`.
 */
export type TokenBucketState = {
  tokens: number;
  lastRefillAt: number;
};

export type TokenBucketConfig = {
  /** Teto de tokens acumuláveis — o tamanho da rajada tolerada. */
  capacity: number;
  /** Tokens repostos por segundo. */
  refillPerSecond: number;
};

export function createBucket(config: TokenBucketConfig, now: number) {
  return { tokens: config.capacity, lastRefillAt: now };
}

/**
 * Tenta consumir `cost` tokens.
 *
 * Devolve `retryAfterMs` quando não há saldo — quem chama espera esse tempo em
 * vez de tentar de novo imediatamente e queimar a cota num laço.
 */
export function consume(
  state: TokenBucketState,
  config: TokenBucketConfig,
  now: number,
  cost = 1,
): { allowed: boolean; state: TokenBucketState; retryAfterMs: number } {
  const refilled = refill(state, config, now);

  if (refilled.tokens >= cost) {
    return {
      allowed: true,
      state: { ...refilled, tokens: refilled.tokens - cost },
      retryAfterMs: 0,
    };
  }

  const missing = cost - refilled.tokens;
  return {
    allowed: false,
    state: refilled,
    retryAfterMs: Math.ceil((missing / config.refillPerSecond) * 1000),
  };
}

function refill(
  state: TokenBucketState,
  config: TokenBucketConfig,
  now: number,
): TokenBucketState {
  const elapsedMs = Math.max(0, now - state.lastRefillAt);
  const replenished = (elapsedMs / 1000) * config.refillPerSecond;

  return {
    tokens: Math.min(config.capacity, state.tokens + replenished),
    lastRefillAt: now,
  };
}
