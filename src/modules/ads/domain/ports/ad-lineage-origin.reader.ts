/**
 * De onde um anúncio recém-descoberto veio, quando veio de uma ação nossa
 * (§9.5 passo 6).
 *
 * **Mora em `ads` porque as colunas são de `ads`.** `lineageId`, `originAdId` e
 * `originActionExecutionId` pertencem ao agregado, e o módulo que possui as
 * colunas possui a regra que as preenche. `sync` chama; `platform-actions` não
 * precisa saber que a linhagem existe — e não poderia ser consultado por `sync`
 * de qualquer forma, porque ele já importa `sync` pelo lease do reaper, e o
 * caminho de volta seria um ciclo.
 */
export type AdLineageOrigin = {
  /** O anúncio que a ação recriou. */
  originAdId: string;
  /** A linhagem dele — é ela que o derivado herda, não o id (§3.6). */
  lineageId: string;
  /** A execução que produziu o id novo. */
  executionId: string;
};

export abstract class AdLineageOriginReader {
  /**
   * A origem de `externalAdId`, se alguma execução bem-sucedida o produziu.
   *
   * Consulta pelo índice `action_executions(result_platform_entity_id)`, que
   * nasceu em A2-S1 exatamente para isto. `null` é o caso comum e barato: quase
   * todo anúncio descoberto é um anúncio que o usuário criou no gerenciador.
   */
  abstract findOriginFor(input: {
    /**
     * §16.7 — a organização entra no `where`, não é inferida da conta.
     *
     * `adAccountId` já implica uma organização, e é exatamente esse tipo de
     * implicação que o gate de tenancy recusa: implicação vale enquanto o join
     * estiver certo, e a invariante precisa valer mesmo quando ele não estiver.
     */
    organizationId: string;
    adAccountId: string;
    externalAdIds: string[];
  }): Promise<Map<string, AdLineageOrigin>>;
}
