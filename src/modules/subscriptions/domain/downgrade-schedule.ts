/**
 * Quando uma queda de plano pode entrar em vigor.
 *
 * Mora no domínio, e não dentro do caso de uso, porque é uma regra de negócio
 * com uma resposta só - a mesma para qualquer provedor de cobrança que venha
 * depois da Stripe.
 */

/** Um ciclo mensal: o que o cliente compra quando assina. */
function oneMonthFrom(instant: Date): Date {
  const result = new Date(instant);
  result.setMonth(result.getMonth() + 1);
  return result;
}

/**
 * A data em que a queda passa a valer - garantidamente no futuro.
 *
 * O downgrade só vale no fim do período **já pago**: o cliente comprou o mês, e
 * tirar o plano antes disso é retomar algo entregue. A data candidata vem do
 * provedor (`current_period_end`) ou da reserva local, e qualquer uma delas pode
 * chegar no passado - por campo ausente, por assinatura recém-criada, por
 * relógio fora de sincronia. Uma data passada faz a queda ser aplicada no
 * primeiro webhook seguinte, que é o contrário exato da regra.
 *
 * Foi o que aconteceu enquanto o fim de período era lido do
 * `billing_cycle_anchor` - o **início** do ciclo. Corrigida a leitura na origem,
 * esta função existe para que a próxima data ruim custe um mês de plano caro a
 * mais, e não o acesso de quem está pagando.
 */
export function resolveDowngradeEffectiveAt(
  candidate: Date | undefined,
  now: Date = new Date(),
): Date {
  if (!candidate || candidate.getTime() <= now.getTime()) {
    return oneMonthFrom(now);
  }

  return candidate;
}
