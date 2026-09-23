/**
 * A janela do mês corrente, em **UTC** — o referencial de toda cota mensal do
 * Creative Lab.
 *
 * Nasceu dentro de `copy-quota.ts`, quando a geração de copy era a única linha
 * do catálogo com teto por mês. Com a análise de criativo ganhando o seu, morar
 * lá faria o segundo medidor importar o arquivo do primeiro para descobrir onde
 * o mês começa — e a alternativa, cada um calculando o próprio, é como a mesma
 * chamada cairia em meses diferentes conforme quem pergunta.
 *
 * **UTC, e não o fuso do negócio.** É o mesmo referencial do teto diário de LLM
 * (`spentTodayBase`), e a coerência entre os dois é o que torna "por que fui
 * cortado?" respondível olhando um calendário só.
 *
 * Houve um segundo par de datas no medidor de faturamento, no fuso do negócio,
 * porque a dimensão que ele media tinha de concordar com o job da madrugada.
 * Essa dimensão saiu da tela, e o segundo calendário saiu com ela: hoje toda
 * cota do produto vira no mesmo instante.
 */
export function monthWindow(now: Date): { since: Date; until: Date } {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const until = new Date(since);
  until.setUTCMonth(until.getUTCMonth() + 1);

  return { since, until };
}
