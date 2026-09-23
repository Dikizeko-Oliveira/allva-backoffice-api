import { utcDay } from './data-maturity';

/**
 * As janelas do sync: o que se lê da plataforma, e sob que chave de idempotência
 * isso conta como "já feito" (§8.2, §8.8).
 */

export type DateWindow = { since: Date; until: Date };

/**
 * A janela de re-declaração rolante.
 *
 * Cada ingest **re-busca os últimos N dias** e faz upsert por
 * `(adId, date, granularity)`. Não é redundância: as plataformas reescrevem o
 * passado, e uma conversão que chega em D+9 atribuída a D só entra na série se
 * alguém voltar a olhar para D.
 */
export function restatementWindow(
  now: Date,
  restatementWindowDays: number,
): DateWindow {
  const until = utcDay(now);
  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - Math.max(1, restatementWindowDays) + 1);

  return { since, until };
}

/**
 * A chave de janela de `JobRun` (§8.8): `2026-08-01T14` para o horário,
 * `2026-08-01` para o diário.
 *
 * É a chave de idempotência — sem ela, "o cron verifica a chave da janela" não
 * tem onde verificar, cada janela roda duas vezes, o custo de LLM dobra (P9) e
 * `occurrences` infla, que é sinal usado por P8.
 */
export type JobCadence = 'HOURLY' | 'DAILY' | 'MONTHLY' | 'FIVE_MINUTES';

export function windowKeyFor(cadence: JobCadence, now: Date): string {
  const iso = now.toISOString();

  switch (cadence) {
    case 'HOURLY':
      return iso.slice(0, 13); // 2026-08-01T14
    case 'DAILY':
      return iso.slice(0, 10); // 2026-08-01
    case 'MONTHLY':
      return iso.slice(0, 7); // 2026-08
    case 'FIVE_MINUTES': {
      const minutes = now.getUTCMinutes();
      const bucket = String(Math.floor(minutes / 5) * 5).padStart(2, '0');
      return `${iso.slice(0, 13)}:${bucket}`;
    }
  }
}

/**
 * Quantos dias o ingest deve ler para trás **nesta** passada.
 *
 * Em regime permanente é a janela de re-declaração: as plataformas reescrevem o
 * passado, e re-ler os últimos N dias é o que captura a conversão que chega em
 * D+9. No **primeiro** ingest de uma conta essa janela é a resposta errada.
 *
 * Um dia só vira `MATURE` com 14 dias de idade (§8.9), e os detectores que
 * produzem número em dinheiro — `ZERO_CONVERSIONS`, `LOW_ROAS`, `HIGH_CPA` —
 * exigem `MATURE`. Lendo 7 dias no cadastro, **nenhum** dia chega maduro: a
 * primeira afirmação confiável saía por volta do 12º dia de uso. Para quem paga
 * isso é duas semanas de silêncio; para um teste de 14 dias, é o produto
 * acabando quase no dia em que começa a funcionar.
 *
 * O backfill resolve na origem: lendo 30 dias, os dias D-29..D-14 já chegam
 * maduros e o detector dispara na primeira madrugada.
 *
 * O teto existe para que aumentar o backfill num `.env` não vire uma varredura
 * de um ano contra o rate limit da plataforma no onboarding (R4).
 */
export function ingestLookbackDaysFor(input: {
  /** Nenhum ingest completo jamais concluiu para esta conta. */
  isFirstIngest: boolean;
  restatementDays: number;
  backfillDays: number;
  maxLookbackDays: number;
}): number {
  const days = input.isFirstIngest
    ? Math.max(input.backfillDays, input.restatementDays)
    : input.restatementDays;

  return Math.min(days, input.maxLookbackDays);
}

/**
 * Estrutura: incremental por `updated_since` desde o último sync bem-sucedido,
 * com **varredura completa em cadência diária**.
 *
 * O incremental é o que sustenta a meta de −60% de chamadas (§17.2). A varredura
 * completa existe porque `updated_since` não reporta remoção: sem ela, um
 * anúncio apagado na plataforma ficaria vivo no domínio para sempre — e ninguém
 * arquiva o que continua "aparecendo".
 */
export function shouldRunFullScan(input: {
  lastSuccessfulFullSyncAt: Date | null;
  supportsUpdatedSince: boolean;
  now: Date;
  /** Cadência mínima da varredura completa. */
  fullScanIntervalHours?: number;
}): boolean {
  // Plataforma sem `updated_since` não tem incremental: toda leitura é completa.
  if (!input.supportsUpdatedSince) return true;
  if (!input.lastSuccessfulFullSyncAt) return true;

  const interval = (input.fullScanIntervalHours ?? 24) * 3_600_000;
  return (
    input.now.getTime() - input.lastSuccessfulFullSyncAt.getTime() >= interval
  );
}

/**
 * O `updated_since` a enviar: o último sync de estrutura bem-sucedido, com uma
 * folga para trás.
 *
 * A folga cobre a diferença de relógio entre nós e a plataforma. Sem ela, uma
 * entidade alterada durante o sync anterior cai no buraco entre as duas
 * leituras e só reaparece na varredura completa do dia seguinte.
 */
export const UPDATED_SINCE_OVERLAP_MS = 10 * 60 * 1000;

export function updatedSinceFor(input: {
  lastStructureSyncAt: Date | null;
  fullScan: boolean;
}): Date | null {
  if (input.fullScan || !input.lastStructureSyncAt) return null;
  return new Date(
    input.lastStructureSyncAt.getTime() - UPDATED_SINCE_OVERLAP_MS,
  );
}
