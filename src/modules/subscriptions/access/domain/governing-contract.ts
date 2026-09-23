/** O mínimo para escolher entre contratos: quem é, e de quando até quando. */
export type ContractTerm = {
  startsAt: Date;
  endsAt: Date;
};

/**
 * Qual dos contratos vivos de uma organização responde **agora**.
 *
 * ## Por que a escolha existe
 *
 * Depois da primeira renovação a organização tem dois contratos vivos ao mesmo
 * tempo: o que está correndo e o que já foi assinado para o ano seguinte.
 * "O mais recente" é a regra que parece certa e fecha o produto no dia em que o
 * comercial assina a renovação — porque o mais recente ainda não começou, e o
 * resolver leria isso como `PENDING_ACTIVATION`. O cliente perderia o acesso
 * que ainda está pago exatamente por ter renovado cedo.
 *
 * ## A ordem de preferência
 *
 * **Em vigor** primeiro — é ele que descreve o acesso de hoje. Depois o
 * **próximo a começar**: sem nenhum em vigor, o cliente está esperando, e
 * "começa em novembro" é uma resposta melhor do que "venceu em agosto" para
 * quem já tem substituto assinado. Por último o **último a terminar**, que é
 * quem explica até quando houve acesso.
 *
 * Os três casos fecham ou abrem o produto pelo mesmo `resolveContractAccess`;
 * o que muda é qual verdade o cliente lê.
 */
export function selectGoverningContract<T extends ContractTerm>(
  contracts: readonly T[],
  now: Date = new Date(),
): T | null {
  if (contracts.length === 0) return null;

  const inForce = contracts
    .filter((c) => c.startsAt <= now && now <= c.endsAt)
    .sort((a, b) => b.startsAt.getTime() - a.startsAt.getTime());

  if (inForce.length > 0) return inForce[0];

  const upcoming = contracts
    .filter((c) => c.startsAt > now)
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  if (upcoming.length > 0) return upcoming[0];

  return [...contracts].sort(
    (a, b) => b.endsAt.getTime() - a.endsAt.getTime(),
  )[0];
}
