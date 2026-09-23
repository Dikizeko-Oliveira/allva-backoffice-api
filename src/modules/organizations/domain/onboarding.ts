/**
 * Onde a conta parou no caminho até o produto ter o que mostrar.
 *
 * Existe porque o frontend vinha inferindo isso de **erros**: "não tem
 * organização" era um 404 de `GET /organizations`, "não tem integração" era
 * lista vazia, e "não tem anúncio" era um `ORGANIZATION_REQUIRED` — que nem
 * descreve o fato. Cada tela chegava à própria conclusão e escrevia a própria
 * mensagem, e foi assim que a dashboard passou a pedir "selecione uma
 * organização" para quem tinha exatamente uma.
 *
 * A decisão passa a ser do servidor, que é quem conhece a ordem real das
 * dependências. A tela só pergunta para onde mandar o botão.
 */
export type OnboardingStep =
  /**
   * Conta de plataforma. Não é um passo do caminho do cliente — é a saída
   * dele: operador não usa o produto com a mesma conta (a rota de produto
   * responde `PLATFORM_ACCOUNT_NOT_CUSTOMER`), então qualquer outro passo
   * apontaria para uma tela que recusa. A tela manda para o backoffice.
   */
  | 'USE_BACKOFFICE'
  | 'CREATE_ORGANIZATION'
  | 'SUBSCRIBE'
  | 'CONNECT_PLATFORM'
  | 'LINK_AD_ACCOUNT'
  | 'AWAITING_FIRST_SYNC'
  | 'READY';

export type OnboardingState = {
  hasOrganization: boolean;
  hasActiveSubscription: boolean;
  hasConnectedIntegration: boolean;
  hasLinkedAdAccount: boolean;
  hasSyncedAds: boolean;
};

/**
 * A ordem **é** a regra, e não é arbitrária: cada passo é pré-requisito técnico
 * do seguinte, não preferência de produto.
 *
 * - Organização antes de tudo: `integrations.organization_id` é NOT NULL, e
 *   `Ad` também. Sem ela o resto não tem onde existir.
 * - Assinatura antes de plataforma: `POST /integrations` está atrás de
 *   `EntitlementGuard` com `@RequireAccessStatuses('ALLOWED','GRACE_PERIOD')`.
 *   Mandar para Integrações sem assinatura ativa é mandar para um 403.
 * - Conta de anúncios depois da credencial: o vínculo nasce de uma integração
 *   conectada, e o teto de plano é cobrado no vínculo.
 *
 * `AWAITING_FIRST_SYNC` é o passo que evita a mentira mais provável desta tela.
 * Quem conectou o Meta e vinculou a conta fez tudo certo, e ainda assim não tem
 * anúncio nenhum até a primeira ingestão rodar. Sem este estado, a dashboard
 * vazia mandaria de volta para Integrações — sugerindo erro onde há só espera.
 */
export function resolveNextStep(state: OnboardingState): OnboardingStep {
  if (!state.hasOrganization) return 'CREATE_ORGANIZATION';
  if (!state.hasActiveSubscription) return 'SUBSCRIBE';
  if (!state.hasConnectedIntegration) return 'CONNECT_PLATFORM';
  if (!state.hasLinkedAdAccount) return 'LINK_AD_ACCOUNT';
  if (!state.hasSyncedAds) return 'AWAITING_FIRST_SYNC';

  return 'READY';
}
