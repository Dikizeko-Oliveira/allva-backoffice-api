import { backoffDelayMs, classifyPlatformError } from './platform-error';
import { consume, createBucket } from './token-bucket';

const CONFIG = { capacity: 10, refillPerSecond: 5 };
const T0 = 1_000_000;

describe('token bucket (R4)', () => {
  it('começa cheio e gasta um token por chamada', () => {
    let state = createBucket(CONFIG, T0);

    const first = consume(state, CONFIG, T0);
    state = first.state;

    expect(first.allowed).toBe(true);
    expect(state.tokens).toBe(9);
  });

  it('recusa quando o saldo acaba e diz quanto esperar', () => {
    let state = createBucket(CONFIG, T0);
    for (let i = 0; i < 10; i += 1) {
      state = consume(state, CONFIG, T0).state;
    }

    const blocked = consume(state, CONFIG, T0);

    expect(blocked.allowed).toBe(false);
    // 1 token a 5/s = 200 ms. Sem esse número, quem chama tentaria de novo
    // imediatamente e queimaria a cota que o balde existe para proteger.
    expect(blocked.retryAfterMs).toBe(200);
  });

  it('repõe proporcionalmente ao tempo decorrido', () => {
    let state = createBucket(CONFIG, T0);
    for (let i = 0; i < 10; i += 1) {
      state = consume(state, CONFIG, T0).state;
    }

    const afterOneSecond = consume(state, CONFIG, T0 + 1000);

    expect(afterOneSecond.allowed).toBe(true);
    expect(afterOneSecond.state.tokens).toBeCloseTo(4, 10);
  });

  it('não acumula além da capacidade', () => {
    const state = createBucket(CONFIG, T0);

    // Uma hora parado não compra uma rajada de mil chamadas.
    const afterAnHour = consume(state, CONFIG, T0 + 3_600_000);

    expect(afterAnHour.state.tokens).toBe(CONFIG.capacity - 1);
  });

  it('cobra o custo declarado quando a chamada vale mais de um token', () => {
    const state = createBucket(CONFIG, T0);

    const batch = consume(state, CONFIG, T0, 4);

    expect(batch.state.tokens).toBe(6);
  });
});

describe('classifyPlatformError', () => {
  it.each([
    [429, 'rate_limit', true],
    [401, 'auth', false],
    [403, 'permission', false],
    [404, 'not_found', false],
    [408, 'timeout', true],
    [500, 'server_error', true],
    [503, 'server_error', true],
    [400, 'bad_request', false],
  ])('classifica HTTP %i como %s', (status, code, retryable) => {
    const classified = classifyPlatformError({ status });

    expect(classified.code).toBe(code);
    expect(classified.retryable).toBe(retryable);
  });

  it('reconhece falha de rede pelo código do socket', () => {
    expect(classifyPlatformError({ errorCode: 'ECONNRESET' })).toMatchObject({
      code: 'network',
      retryable: true,
    });
  });

  it('não inventa classificação sem evidência', () => {
    expect(classifyPlatformError({ message: 'algo aconteceu' })).toMatchObject({
      code: 'unknown',
      retryable: false,
    });
  });
});

describe('backoffDelayMs', () => {
  it('respeita o Retry-After da plataforma acima de tudo', () => {
    // Ela sabe quando volta a aceitar; qualquer heurística nossa é pior.
    expect(backoffDelayMs({ attempt: 1, retryAfterMs: 7000 })).toBe(7000);
  });

  it('cresce exponencialmente entre tentativas', () => {
    const ceiling = (attempt: number) =>
      backoffDelayMs({ attempt, random: () => 1 });

    expect(ceiling(1)).toBe(500);
    expect(ceiling(2)).toBe(1000);
    expect(ceiling(3)).toBe(2000);
  });

  it('aplica jitter — dois workers não voltam no mesmo milissegundo', () => {
    // Sem jitter, N workers que tomaram 429 na mesma janela voltam juntos e
    // tomam 429 de novo, em fase: a plataforma vê uma rajada periódica em vez
    // de uma retomada gradual.
    const low = backoffDelayMs({ attempt: 5, random: () => 0.1 });
    const high = backoffDelayMs({ attempt: 5, random: () => 0.9 });

    expect(low).toBeLessThan(high);
  });

  it('nunca passa do teto', () => {
    expect(backoffDelayMs({ attempt: 30, random: () => 1 })).toBe(60_000);
  });
});
