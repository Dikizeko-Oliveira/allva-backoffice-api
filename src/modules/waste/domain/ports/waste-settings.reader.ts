/**
 * A configuração da organização que a **leitura** de desperdício declara.
 *
 * Separada de `WasteTargetsRepositoryInterface` de propósito: aquela é do ciclo
 * de detecção e é por conta de anúncios; esta é por organização e serve o
 * `meta.provenance` de toda rota. Fundi-las faria a listagem carregar saúde de
 * conta e maturidade de janela — coisas que ela não usa e que a obrigariam a
 * consultar por nada.
 */
export type WasteReadSettings = {
  organizationId: string;
  /** A janela ativa (D8/DEC-11): **declarada** no rollup, nunca filtrada. */
  windowDays: number;
  detectorProfileVersion: string;
  baseCurrency: string;
  /**
   * §8.7: em `RECOMPUTING_CURRENCY` os números da organização estão sendo
   * reescritos, e a tela precisa saber para não apresentar um agregado a meio
   * caminho como se fosse o valor final.
   */
  recomputingCurrency: boolean;
};

export abstract class WasteSettingsReader {
  abstract forOrganization(organizationId: string): Promise<WasteReadSettings>;
}
