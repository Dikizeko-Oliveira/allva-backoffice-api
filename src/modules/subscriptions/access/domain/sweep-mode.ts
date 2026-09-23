import { PRODUCT_ACCESS_ALLOWED, isAccessAllowed } from './access-policy';
import { AccessStatus } from './access-status';

/**
 * O quanto os jobs varrem uma organização.
 *
 * - `FULL`: tudo — ingest na cadência do plano, reconciliação, descoberta de
 *   contas, régua de análise, scoring, desperdício, recomendações e resumo.
 * - `DAILY_SYNC_ONLY`: só a varredura completa diária (`ads-ingest-full`).
 *   Nenhuma análise, nenhuma chamada de IA.
 * - `NONE`: nada.
 */
export type SweepMode = 'FULL' | 'DAILY_SYNC_ONLY' | 'NONE';

/**
 * Por quanto tempo uma organização que perdeu acesso ainda recebe o sync diário.
 *
 * ## Por que não corta na hora
 *
 * Quem regulariza a cobrança volta para a tela no mesmo dia. Cortar o sync no
 * instante do fechamento o faria voltar a números de dias atrás. Dois dias
 * cobrem o caso comum — boleto compensando, cartão trocado — pelo preço de duas
 * varreduras completas, sem análise nem IA por cima delas.
 *
 * ## Por que não conflita com a tolerância do Enterprise
 *
 * A janela começa quando o **resolver** fecha o acesso. A tolerância do contrato
 * (`gracePeriodDays`) é acesso aberto — `GRACE_PERIOD` —, então durante ela a
 * organização segue em `FULL`, na cadência do plano. As 48h só começam depois
 * que a tolerância inteira passou: somam-se a ela, nunca a encurtam. O mesmo
 * vale para a graça do `PAST_DUE` da Stripe.
 */
export const CLOSED_ACCESS_DAILY_SYNC_HOURS = 48;

const HOUR_MS = 60 * 60 * 1000;

export function sweepModeFor(input: {
  deleted: boolean;
  access: AccessStatus;
  /**
   * Quando a varredura observou o fechamento. Nulo é a primeira observação —
   * a janela começa agora.
   */
  accessClosedAt: Date | null;
  now: Date;
}): SweepMode {
  // Organização excluída não tem quem olhe o número: nem janela, nem análise.
  if (input.deleted) return 'NONE';

  if (isAccessAllowed(input.access, PRODUCT_ACCESS_ALLOWED)) return 'FULL';

  const closedAt = input.accessClosedAt ?? input.now;
  const elapsedMs = input.now.getTime() - closedAt.getTime();

  return elapsedMs < CLOSED_ACCESS_DAILY_SYNC_HOURS * HOUR_MS
    ? 'DAILY_SYNC_ONLY'
    : 'NONE';
}
