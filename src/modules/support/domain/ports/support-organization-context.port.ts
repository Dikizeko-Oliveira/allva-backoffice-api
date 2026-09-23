/** O contexto que a fila do operador mostra ao lado de cada chamado. */
export type SupportOrganizationContext = {
  name: string | null;
  /** Plano vigente. `null` quando a organização não tem assinatura. */
  planType: string | null;
};

/**
 * Nome e plano de várias organizações **de uma vez**.
 *
 * Em lote, e não uma por chamado, porque é o defeito que o mapa de endpoints
 * do backoffice já registra em B1: sem o contexto no payload, cada linha da
 * fila custaria dois `GET` extras, e uma página de vinte viraria quarenta
 * requisições.
 *
 * Port próprio em vez de `OrganizationsRepositoryInterface` +
 * `OrganizationPlanPortInterface`: as duas respondem por uma organização por
 * chamada, e compô-las aqui produziria exatamente o N+1 que este port existe
 * para evitar.
 */
export abstract class SupportOrganizationContextPortInterface {
  abstract resolveMany(
    organizationIds: readonly string[],
  ): Promise<Map<string, SupportOrganizationContext>>;
}
