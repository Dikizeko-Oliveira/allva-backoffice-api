import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import {
  VERIFICATION_LADDER_MS,
  ladderExhausted,
  nextVerificationDelayMs,
  verifyWrite,
} from './verification-ladder';

/** O mapa da Meta, reduzido ao que estes casos exercitam. */
const toCanonical = (raw: string): AdStatus =>
  (({
    ACTIVE: 'ACTIVE',
    PAUSED: 'PAUSED',
    ADSET_PAUSED: 'PAUSED',
    ARCHIVED: 'ARCHIVED',
    DELETED: 'DELETED',
  })[raw] ?? 'UNKNOWN') as AdStatus;

function verify(overrides: Partial<Parameters<typeof verifyWrite>[0]> = {}) {
  return verifyWrite({
    desiredStatus: 'PAUSED',
    observed: { status: 'PAUSED' },
    toCanonical,
    attempt: 0,
    ...overrides,
  });
}

describe('a escada (§13.4)', () => {
  it('sobe T+90s → 5min → 30min → 2h', () => {
    expect(VERIFICATION_LADDER_MS).toEqual([
      90_000, 300_000, 1_800_000, 7_200_000,
    ]);
  });

  it('acaba depois do quarto degrau', () => {
    expect(nextVerificationDelayMs(0)).toBe(90_000);
    expect(nextVerificationDelayMs(3)).toBe(7_200_000);
    expect(nextVerificationDelayMs(4)).toBeNull();
    expect(ladderExhausted(4)).toBe(true);
    expect(ladderExhausted(3)).toBe(false);
  });
});

describe('verificação de escrita', () => {
  it('confirma quando o observado bate com o desejado', () => {
    expect(verify()).toEqual({ outcome: 'CONFIRMED', retryInMs: null });
  });

  /**
   * `effective_status` traz estados compostos: um anúncio dentro de conjunto
   * pausado responde `ADSET_PAUSED`. Canonicamente é `PAUSED`, e comparar a
   * string crua reportaria divergência sobre uma escrita que funcionou.
   */
  it('compara pelo status canônico, não pelo cru da plataforma', () => {
    expect(verify({ observed: { status: 'ADSET_PAUSED' } }).outcome).toBe(
      'CONFIRMED',
    );
  });

  /**
   * **`DIVERGED` não reagenda.** A pergunta está respondida: o alvo está em
   * outro estado definido. Insistir produziria a mesma resposta quatro vezes e
   * gastaria quatro leituras de um orçamento que R4 controla.
   */
  it('declara divergência sem subir a escada', () => {
    expect(verify({ observed: { status: 'ACTIVE' } })).toEqual({
      outcome: 'DIVERGED',
      retryInMs: null,
    });
  });

  it('reagenda quando a leitura falhou', () => {
    expect(verify({ observed: null })).toEqual({
      outcome: 'INCONCLUSIVE',
      retryInMs: 90_000,
    });
    expect(verify({ observed: null, attempt: 2 }).retryInMs).toBe(1_800_000);
  });

  /**
   * Status não mapeado é **não saber ler**, não divergir. Chamá-lo de
   * divergência afirmaria que a escrita não pegou com base na nossa ignorância —
   * e a plataforma acrescenta estados sem avisar.
   */
  it('trata status desconhecido como inconclusivo, nunca como divergência', () => {
    const result = verify({ observed: { status: 'ALGO_NOVO_DA_META' } });

    expect(result.outcome).toBe('INCONCLUSIVE');
    expect(result.retryInMs).toBe(90_000);
  });

  /**
   * O estado terminal de §13.4: escrevemos, a plataforma aceitou, e nunca
   * conseguimos confirmar. É afirmação honesta, e distinta de `DIVERGED` — que
   * afirma que não pegou — e de `INCONCLUSIVE`, que ainda espera.
   */
  it('esgota em UNVERIFIED_WRITE depois do último degrau', () => {
    expect(verify({ observed: null, attempt: 4 })).toEqual({
      outcome: 'UNVERIFIED_WRITE',
      retryInMs: null,
    });
  });

  /**
   * Orçamento não tem estado desejado no anúncio. Ler a entidade é toda a
   * confirmação disponível aqui — o valor é reconferido pelo sync, que conhece
   * a moeda da conta e converte a unidade menor sem adivinhar.
   */
  it('confirma ação sem estado desejado quando a leitura funciona', () => {
    const result = verify({
      desiredStatus: null,
      observed: { status: 'ACTIVE', dailyBudgetMinor: '15050' },
    });

    expect(result.outcome).toBe('CONFIRMED');
  });

  it('não confirma ação sem estado desejado quando a leitura falha', () => {
    expect(verify({ desiredStatus: null, observed: null }).outcome).toBe(
      'INCONCLUSIVE',
    );
  });
});
