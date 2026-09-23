/** O resultado de uma corrida de seleção, por organização. */
export type AnalysisScopeOutcome = {
  organizationId: string;
  /** Anúncios que entram na análise da noite. */
  eligible: number;
  /** Anúncios sincronizados e visíveis que ficam de fora — o número a declarar. */
  excludedByPlanLimit: number;
};

/**
 * A régua de quantos anúncios entram na análise (§ teto de plano).
 *
 * **Materializa, não filtra na hora.** Cada motor podia rodar o próprio ranking
 * por gasto e pegar os N primeiros — e os três divergiriam. `ad-scoring` roda às
 * 05:30, `waste` às 06:00, e entre as duas o ingest de hora em hora reescreve o
 * gasto do dia: o score analisaria um conjunto e o detector outro, sobre a mesma
 * organização e a mesma noite. A recomendação, que compõe os dois, herdaria a
 * divergência sem ter como notá-la.
 *
 * Carimbar uma vez e todo mundo ler o carimbo troca três decisões por uma.
 */
export abstract class AnalysisScopeRepositoryInterface {
  /** Organizações com ao menos um anúncio não arquivado. */
  abstract listOrganizationsWithAds(): Promise<string[]>;

  /**
   * Carimba os `limit` anúncios que mais gastaram na janela e limpa o resto.
   *
   * `limit` nulo é ilimitado: **todos** são carimbados. O caminho não é um
   * atalho que pula a corrida — ele grava do mesmo jeito, para que o filtro dos
   * motores seja uma condição só (`analysisEligibleAt IS NOT NULL`) em vez de
   * uma condicional que precisa saber o plano.
   */
  abstract markEligible(input: {
    organizationId: string;
    limit: number | null;
    since: Date;
    until: Date;
    now: Date;
  }): Promise<AnalysisScopeOutcome>;

  /** Quantos anúncios da organização estão fora do conjunto analisado. */
  abstract countExcluded(organizationId: string): Promise<number>;

  /**
   * Quantos anúncios **esperam vaga** na faixa de rodízio.
   *
   * Não é `countExcluded`, e a diferença é o ponto: aquele conta todo anúncio
   * fora do escopo, incluindo a cauda morta — pausado, sem entrega, sem gasto —,
   * que o rodízio nunca chama porque anúncio que não entrega não pode estar
   * desperdiçando. Usar aquele número como denominador do ciclo o
   * superestimaria, às vezes muito: a cauda de uma conta real é
   * majoritariamente anúncio morto, e a tela prometeria uma espera que não
   * existe.
   *
   * Este conta a fila de verdade: entrega na janela e fora do escopo agora. É o
   * denominador de `rotationCycleNights`, e a mesma janela e o mesmo filtro que
   * `markEligible` usa para escolher — senão o ciclo descrito não é o ciclo que
   * acontece.
   */
  abstract countRotationQueue(input: {
    organizationId: string;
    since: Date;
    until: Date;
  }): Promise<number>;

  /**
   * Quantos anúncios estão **dentro** do escopo agora.
   *
   * É o uso contra o teto de anúncios monitorados, e existe para quem precisa
   * comparar os dois antes de mexer no teto — reduzi-lo derruba a diferença na
   * próxima varredura, e essa é a única dimensão negociada que muda o produto
   * sem ninguém clicar em nada.
   */
  abstract countEligible(organizationId: string): Promise<number>;
}
