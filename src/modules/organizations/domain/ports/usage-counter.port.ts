/**
 * O consumo já autorizado de uma cota, no período corrente.
 *
 * ## Por que uma porta, e por que aqui
 *
 * Aqui pelo mesmo motivo de `OrganizationQuotaPortInterface`: quem pergunta é o
 * módulo de planos, que não deve conhecer o schema de organizações. E porta em
 * vez de repositório concreto porque a atomicidade da reserva é uma **garantia
 * de contrato**, não um detalhe do Postgres — quem consome tem o direito de
 * confiar nela sem ler o SQL, e um dublê de teste tem a obrigação de honrá-la.
 *
 * ## A operação é reservar, não incrementar
 *
 * A diferença é o ponto da porta inteira. `incrementar` deixaria a decisão
 * ("cabe?") de um lado e o efeito ("mais um") do outro, com uma janela entre os
 * dois — que é exatamente o defeito que isto corrige. `reservar` responde as
 * duas ao mesmo tempo: ou devolve o novo total, ou devolve `null` porque não
 * coube.
 */
export abstract class UsageCounterPortInterface {
  /**
   * Consome uma unidade da cota, se couber.
   *
   * Devolve o **novo** total consumido, ou `null` quando o teto já estava
   * atingido. `limit: null` é "sem teto nesta linha": conta, e nunca recusa.
   *
   * Atômico por contrato: duas chamadas concorrentes para a mesma
   * `(organização, feature, período)` nunca podem devolver o mesmo número, e a
   * soma das que devolveram valor nunca ultrapassa `limit`.
   */
  abstract reserve(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
    limit: number | null;
  }): Promise<number | null>;

  /**
   * Devolve uma unidade reservada cujo trabalho não aconteceu.
   *
   * É o que mantém o contador honesto sem job de conciliação: o provider caiu, a
   * persistência falhou, o teto de gasto cortou depois da reserva. Nunca desce
   * abaixo de zero — uma devolução a mais é um bug de chamador, e absorvê-la é
   * melhor que deixar o contador negativo e a cota virar infinita.
   */
  abstract release(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
  }): Promise<void>;

  /** Quanto já foi consumido no período. Zero quando não há linha. */
  abstract read(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
  }): Promise<number>;
}
