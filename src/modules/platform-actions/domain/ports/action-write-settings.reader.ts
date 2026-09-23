/**
 * A configuração de escrita da organização (C10).
 *
 * Um port próprio, e não o repositório de `OrganizationAdsSettings` inteiro: a
 * escrita precisa de um número, e importar o leitor completo traria janela de
 * scoring, versões de prompt e orçamento de LLM junto — campos que este caminho
 * não usa e que, estando à mão, alguém acabaria usando.
 */
export abstract class ActionWriteSettingsReader {
  /**
   * O teto diário, ou `null` quando não há.
   *
   * `null` é ausência de teto, não teto zero: uma organização que nunca
   * configurou o limite escreve normalmente. Colapsar os dois pararia toda
   * escrita da base no dia em que a coluna nascesse.
   */
  abstract actionDailyCap(organizationId: string): Promise<number | null>;

  /** O kill switch por organização (§13.5) — dono desta coluna. */
  abstract setActionsEnabled(input: {
    organizationId: string;
    enabled: boolean;
  }): Promise<void>;

  /**
   * O estado atual do kill switch.
   *
   * Existe porque **a escrita sozinha não basta para desenhar o controle**: até
   * A2-S9 o valor só era legível por `GET /ads/{id}/actions/available`, que
   * exige um anúncio, ou como retorno do próprio `PUT`. Uma tela de segurança
   * que precisa adivinhar o estado inicial mostra "ligado" para uma organização
   * desligada — e o usuário confia no que está escrito.
   */
  abstract actionsEnabled(organizationId: string): Promise<boolean>;
}
