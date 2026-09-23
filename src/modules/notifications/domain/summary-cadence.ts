import type { SummaryCadence } from 'src/modules/plans/domain/plan-entitlements';

/**
 * Segunda-feira. Casa com o "Semanal (segundas)" que o catálogo mostra — mudar
 * um sem o outro faz a landing prometer um dia e o job entregar outro.
 */
const WEEKLY_WEEKDAY = 'Mon';

/**
 * O resumo sai hoje?
 *
 * `DAILY` sai sempre; `WEEKLY` só na segunda.
 *
 * ## Por que o fuso é argumento, e não `getDay()`
 *
 * O cron dispara às 08:00 em `SCHEDULER_TIMEZONE`, que não é necessariamente o
 * fuso do processo. `Date.getDay()` responde no fuso do **servidor**, e as duas
 * respostas divergem sempre que o instante cai perto da virada do dia: às 11:00
 * UTC de segunda, um servidor em UTC−12 lê domingo. O resumo semanal sumiria
 * silenciosamente — nunca seria segunda para ele —, e o sintoma seria "o
 * Individual parou de receber email", meses depois, sem nada nos logs.
 *
 * Perguntar o dia **no fuso do agendamento** elimina a classe inteira do
 * problema, em vez de depender de o deploy continuar rodando em UTC.
 */
export function shouldSendSummaryToday(input: {
  cadence: SummaryCadence;
  now: Date;
  timeZone: string;
}): boolean {
  if (input.cadence === 'DAILY') return true;

  return weekdayIn(input.timeZone, input.now) === WEEKLY_WEEKDAY;
}

/** O dia da semana em três letras ("Mon"), no fuso pedido. */
function weekdayIn(timeZone: string, date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(date);
}
