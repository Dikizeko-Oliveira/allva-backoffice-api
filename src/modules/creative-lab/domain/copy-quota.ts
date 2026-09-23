/**
 * A cota **mensal** de gerações de copy, e a retenção do que foi gerado.
 *
 * ## Por que um medidor mensal, aqui, depois de o catálogo ter evitado um
 *
 * A linha `creative-lab` do catálogo registra a decisão oposta — liga/desliga em
 * vez de "20 por mês" —, e a diferença aqui é de packaging, não de custo: a
 * geração de copy é oferecida nos três planos, e o que os separa é o volume. Sem
 * medidor, "limite menor no Individual" não existiria.
 *
 * ## O medidor era a própria tabela, e deixou de ser
 *
 * A primeira versão contava `copy_generations` do mês corrente, com o argumento
 * de que não haveria contador incremental, fechamento de mês nem conciliação —
 * as três coisas que tornariam a cota cara e divergente. O argumento estava
 * certo sobre custo e errado sobre **concorrência**: `COUNT` e depois `INSERT`
 * não são atômicos, e dois pedidos simultâneos com 99 de 100 usados liam 99 os
 * dois e passavam os dois. O mês fechava em 101, e a tela de assinatura exibia
 * o furo em letras grandes.
 *
 * Hoje a reserva é uma instrução só em `organization_usage_counters`, e o que
 * ela conta é **autorização concedida**. Os dois medos originais não se
 * concretizaram: o período faz parte da chave primária, então virar o mês é
 * inserir outra linha — não há fechamento —, e quem reserva devolve quando o
 * trabalho não acontece, então não há conciliação.
 *
 * **Os dois tetos continuam existindo e medem coisas diferentes**: a cota mensal
 * governa quantas vezes a pessoa pode pedir; o `llmDailyBudgetBase` governa
 * quanto dinheiro sai por dia. Um teto de volume e um teto de gasto não são "dois
 * limites sobre o mesmo gasto" — o segundo continua sendo a parede.
 */

/**
 * A janela do mês corrente — **compartilhada com a cota de análise**.
 *
 * Mudou de casa quando a análise de criativo ganhou o próprio teto mensal: duas
 * cotas do mesmo módulo precisam concordar sobre onde o mês começa, e a segunda
 * importar o arquivo da primeira para descobrir isso seria a dependência
 * errada. A razão do UTC está na declaração, em `month-window.ts`.
 */
export { monthWindow } from './month-window';

/**
 * Quantas variações cada geração produz — **três, fixo**.
 *
 * Foi avaliado torná-lo alavanca de plano, junto com a cota mensal, e a resposta
 * é não por três razões:
 *
 * 1. **Não economiza.** As três saem de **uma** chamada; cortar para duas
 *    reduz só tokens de saída, que é a fração menor do custo. A cota mensal já
 *    governa o gasto, e ela governa a parte que importa.
 * 2. **Duas não é "um pouco menos" — é outro produto.** Três ângulos existem
 *    para testar hipótese (benefício, dor, resultado); com dois, a comparação
 *    que justifica a feature deixa de caber.
 * 3. **Dois limites sobre a mesma decisão divergem**, e o que erra é o que
 *    ninguém revisita — o argumento que o catálogo já usou para recusar a cota
 *    de `creative-lab`.
 */
export const VARIANTS_PER_GENERATION = 3;

/**
 * D5 — quantos dias o conteúdo gerado fica preservado antes de ficar
 * **elegível** a expurgo.
 *
 * Elegível não é agendado: a poda só alcança organização fora de dia com a
 * cobrança. Enquanto o cliente está ativo, o texto é ativo dele — foi ele quem
 * pediu, e é ele quem publica.
 *
 * Enquanto a conta está bloqueada, o conteúdo continua **existindo** e fica
 * **inacessível**: quem barra a leitura é o `EntitlementGuard` da rota, que
 * exige `ALLOWED` ou `GRACE_PERIOD` como todas as demais. Não há apagamento no
 * bloqueio, e é essa distinção que dá ao cliente a chance de regularizar sem
 * perder o que produziu.
 */
export const COPY_RETENTION_DAYS = 60;

/** O instante a partir do qual esta geração se torna elegível a expurgo. */
export function retentionUntil(createdAt: Date): Date {
  const until = new Date(createdAt);
  until.setUTCDate(until.getUTCDate() + COPY_RETENTION_DAYS);

  return until;
}
