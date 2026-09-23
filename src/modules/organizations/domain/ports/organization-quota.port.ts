/**
 * Os tetos que um contrato negociou, acima do que o plano publica.
 *
 * `null` em qualquer campo é **"herda o plano"**, nunca "ilimitado" — a
 * distinção é o ponto da tabela inteira. Ler um campo vazio como ilimitado
 * reintroduziria exatamente o que ela veio remover.
 */
export type OrganizationQuotaOverrides = {
  adAccounts: number | null;
  monitoredAds: number | null;
  seats: number | null;
  organizations: number | null;
  /** Gerações de copy por mês. Mesma regra: `null` herda o plano. */
  copyGenerations: number | null;
  /** Análises de criativo por mês — a parede da rota `POST /ads/{id}/analyze`. */
  creativeAnalyses: number | null;
};

/** Nenhum teto negociado — toda organização sem linha na tabela cai aqui. */
export const NO_QUOTA_OVERRIDES: OrganizationQuotaOverrides = {
  adAccounts: null,
  monitoredAds: null,
  seats: null,
  organizations: null,
  copyGenerations: null,
  creativeAnalyses: null,
};

/**
 * Lê os tetos negociados de uma organização.
 *
 * Porta e não repositório concreto pelo mesmo motivo de
 * `OrganizationPlanPortInterface`: quem pergunta é o módulo de planos, que não
 * deve conhecer o schema de organizações — e é o que permite testar a resolução
 * de cota sem banco.
 */
/**
 * A alteração de um contrato, campo a campo.
 *
 * `Partial` é o que separa **omitir** de **limpar**: chave ausente não mexe no
 * teto, `null` o apaga e devolve a linha ao plano. Um objeto completo
 * obrigaria quem corrige só o número de contas a reenviar os outros três — e
 * quem esquecesse um apagaria um teto contratado sem perceber.
 */
export type OrganizationQuotaPatch = Partial<OrganizationQuotaOverrides>;

export abstract class OrganizationQuotaPortInterface {
  abstract findOverrides(
    organizationId: string,
  ): Promise<OrganizationQuotaOverrides>;

  /** Grava o contrato e devolve como ele ficou. */
  abstract upsertOverrides(
    organizationId: string,
    patch: OrganizationQuotaPatch,
  ): Promise<OrganizationQuotaOverrides>;
}
