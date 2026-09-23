/**
 * Os sinais de onboarding que vivem em tabelas de outros módulos.
 *
 * Port aqui, e não import de `IntegrationsModule`, porque `IntegrationsModule`
 * importa `OrganizationsModule` — a volta fecharia um ciclo, e o projeto não usa
 * `forwardRef` em lugar nenhum. É a mesma forma de `OrganizationPlanPortInterface`,
 * que lê `organization_subscriptions` sem que este módulo conheça o de
 * assinaturas: o contrato pertence a quem pergunta, a leitura mora no adaptador.
 */
export type OnboardingSignals = {
  /** Existe credencial de plataforma CONNECTED nesta organização. */
  hasConnectedIntegration: boolean;
  /** Existe conta de anúncios vinculada a uma credencial. */
  hasLinkedAdAccount: boolean;
  /** A ingestão já trouxe pelo menos um anúncio. */
  hasSyncedAds: boolean;
};

export abstract class OnboardingStatePortInterface {
  abstract readSignals(organizationId: string): Promise<OnboardingSignals>;
}
