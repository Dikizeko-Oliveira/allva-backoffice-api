/**
 * A partir de quantos dias sem reconfirmação um achado deixa de descrever o
 * presente.
 *
 * ## Por que sete
 *
 * O detector reconfirma todo achado do conjunto analisado a cada madrugada. Com
 * o núcleo estável isso é diário; com o rodízio, um anúncio da cauda volta a
 * cada N noites, e N cresce com o tamanho da conta. Sete dias é o ponto em que
 * "ainda não voltou na fila" vira "faz uma semana que ninguém olha" — tempo
 * suficiente para uma campanha inteira mudar de comportamento.
 *
 * **Não é prazo de validade.** O achado continua aberto e continua verdadeiro
 * até que a varredura diga o contrário; o que este limiar governa é o produto
 * **declarar** quanto do total não passou por confirmação recente. Fechá-los por
 * idade seria pior: resolveria em silêncio um desperdício que talvez continue
 * saindo da conta do cliente.
 */
export const UNVERIFIED_AFTER_DAYS = 7;

/** O instante antes do qual um `lastSeenAt` conta como não reverificado. */
export function unverifiedBefore(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(cutoff.getUTCDate() - UNVERIFIED_AFTER_DAYS);

  return cutoff;
}
