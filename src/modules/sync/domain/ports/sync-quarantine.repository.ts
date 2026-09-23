import type { QuarantineReason, QuarantineResolution } from '../quarantine';

/**
 * A quarentena, com **caminho de volta** (C6).
 *
 * A unique parcial `sync_quarantine_open_unique` — `(ad_account_id,
 * external_ad_id) WHERE resolved_at IS NULL` — é o que impede o mesmo anúncio de
 * gerar uma linha nova a cada ingest. Sem ela a tabela cresceria uma linha por
 * hora por anúncio órfão, e `attempts` (que é o sinal de "isto não vai
 * resolver") nunca passaria de 1.
 */

export type QuarantineRecord = {
  id: string;
  organizationId: string;
  adAccountId: string;
  externalAdId: string;
  reason: string;
  attempts: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  payload: Record<string, unknown> | null;
};

export type QuarantineListQuery = {
  organizationId: string;
  adAccountId?: string;
  /** Cursor opaco de §7.0.5 — a lista é volátil, e offset repete linha. */
  cursor?: string | null;
  limit: number;
};

export abstract class SyncQuarantineRepositoryInterface {
  /**
   * Registra ou recorre. Recorrer incrementa `attempts` e move `lastSeenAt`;
   * nunca cria uma segunda linha aberta para o mesmo anúncio.
   */
  abstract record(input: {
    organizationId: string;
    adAccountId: string;
    externalAdId: string;
    reason: QuarantineReason;
    payload: Record<string, unknown> | null;
    now: Date;
  }): Promise<void>;

  /** Os itens ainda abertos da conta — lidos **antes** de processar o ingest. */
  abstract listOpen(adAccountId: string): Promise<QuarantineRecord[]>;

  abstract resolve(input: {
    ids: string[];
    resolution: QuarantineResolution;
    at: Date;
  }): Promise<number>;

  abstract list(query: QuarantineListQuery): Promise<{
    items: QuarantineRecord[];
    nextCursor: string | null;
  }>;
}
