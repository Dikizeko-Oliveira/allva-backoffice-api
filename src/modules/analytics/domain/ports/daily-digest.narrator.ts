import type { DigestFacts } from '../daily-digest';

export type DigestNarrationResult = {
  /** `null` sempre que a IA não pôde ou não deveria falar. Nunca uma desculpa. */
  narrative: string | null;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
  outcome: 'SUCCEEDED' | 'FAILED' | 'SKIPPED_BUDGET';
};

/**
 * Quem redige o resumo — **e não quem o apura**.
 *
 * O contrato recebe fatos já calculados e devolve texto. A separação é P4 em
 * forma de assinatura: não há como este port inventar um número, porque ele não
 * tem de onde tirar um.
 */
export abstract class DailyDigestNarrator {
  abstract narrate(input: {
    organizationId: string;
    facts: DigestFacts;
    inputDigest: string;
    correlationId: string | null;
  }): Promise<DigestNarrationResult>;
}
