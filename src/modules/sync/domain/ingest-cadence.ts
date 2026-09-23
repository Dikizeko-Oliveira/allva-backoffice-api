/**
 * Esta hora é hora de ingerir, para um plano com este intervalo?
 *
 * O cron dispara de hora em hora e este teste peneira: intervalo `1` passa
 * sempre, `4` passa às 00, 04, 08, 12, 16 e 20.
 *
 * ## Por que ancorar na hora do dia, e não no "último sync"
 *
 * Comparar com `lastSyncedAt` daria intervalos que **deslizam**: cada execução
 * atrasa alguns minutos, o atraso acumula, e em poucos dias a conta de 4 em 4
 * horas estaria sincronizando 5 em 5. Pior, a hora da primeira sincronização
 * decidiria para sempre o horário de todas — duas contas do mesmo cliente
 * ficariam desalinhadas sem motivo. Ancorado na hora do dia, o passo é fixo,
 * previsível e igual para todo mundo no mesmo plano.
 *
 * O fuso é **obrigatório** e vem de quem agenda, pelo mesmo motivo do resumo
 * semanal: `getHours()` responde no fuso do processo, que não é necessariamente
 * aquele em que o cron foi declarado. Ele não tem default porque o domínio não
 * conhece a configuração do agendador — importar `SCHEDULER_TIMEZONE` aqui é
 * `domain/` dependendo de `infrastructure/`, e há teste de arquitetura cobrando.
 */
export function isIngestHour(input: {
  intervalHours: number;
  now: Date;
  timeZone: string;
}): boolean {
  /**
   * `Math.max(1, …)` sozinho não bastava: `Math.floor(NaN)` é `NaN`, `Math.max`
   * propaga o `NaN`, e `hora % NaN` nunca é zero — a conta pararia de
   * sincronizar **para sempre**, sem erro e sem log. Um intervalo que não é
   * número finito maior que 1 vira 1: na dúvida, sincroniza.
   */
  const floored = Math.floor(input.intervalHours);
  const interval = Number.isFinite(floored) && floored > 1 ? floored : 1;

  if (interval === 1) return true;

  return hourIn(input.timeZone, input.now) % interval === 0;
}

/** A hora do dia (0–23) no fuso pedido. */
function hourIn(timeZone: string, date: Date): number {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(date);

  // `hour12: false` ainda pode devolver "24" na virada, em algumas engines.
  return Number(formatted) % 24;
}
