import type { DigestFacts } from '../daily-digest';

export type StoredDigest = {
  digestDate: Date;
  inputDigest: string;
  facts: DigestFacts;
  narrative: string | null;
  enrichedByAI: boolean;
  promptVersion: string | null;
  reusedFromDate: Date | null;
};

export abstract class DailyDigestRepositoryInterface {
  /** O resumo mais recente da organização — o que o card lê. */
  abstract latestFor(organizationId: string): Promise<StoredDigest | null>;

  /** O resumo de um dia específico, para o job saber se já rodou. */
  abstract findByDate(input: {
    organizationId: string;
    digestDate: Date;
  }): Promise<StoredDigest | null>;

  /**
   * Grava o resumo do dia.
   *
   * `upsert` pela unique `(organizationId, digestDate)`: enfileirar o job duas
   * vezes não pode produzir dois resumos, e a segunda execução encontra a linha
   * do dia em vez de criar outra.
   */
  abstract save(input: {
    organizationId: string;
    digestDate: Date;
    inputDigest: string;
    facts: DigestFacts;
    narrative: string | null;
    enrichedByAI: boolean;
    promptVersion: string | null;
    reusedFromDate: Date | null;
  }): Promise<void>;

  /**
   * Organizações com sync bem-sucedido nas últimas 24h.
   *
   * **Só elas entram na fila.** Uma organização sem dado novo produziria digest
   * idêntico e cairia em `SKIPPED_DIGEST` de qualquer forma — mas nem enfileirar
   * economiza o ciclo inteiro, e o ciclo é por organização.
   */
  abstract listOrganizationsWithRecentSync(since: Date): Promise<string[]>;
}
