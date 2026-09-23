/**
 * O checklist de "Primeiros passos" da Central de suporte.
 *
 * **Não é o mesmo objeto que `OnboardingStep` de `organizations/domain`**, e a
 * diferença não é cosmética. Aquele responde "onde a conta parou no caminho
 * até o produto ter o que mostrar" — uma cadeia linear de pré-requisitos
 * técnicos, em que só o *próximo* passo importa e o botão da tela vazia
 * aponta para ele. Este responde outra pergunta: "quais destas tarefas de
 * configuração já foram feitas" — itens independentes, todos visíveis ao
 * mesmo tempo, marcáveis fora de ordem, e com uma porcentagem em cima.
 *
 * O que os dois têm em comum são os *sinais*, não a lista: integração
 * conectada e anúncio sincronizado saem de `OnboardingStatePortInterface`, a
 * mesma porta que `GET /auth/me` lê. Reimplementar essas duas consultas aqui
 * é como a dashboard e esta tela passariam a discordar sobre se a integração
 * está de pé.
 */
export const SupportOnboardingStepValues = [
  'ORGANIZATION_PROFILE',
  'INVITE_TEAM',
  'CONNECT_INTEGRATIONS',
  'NOTIFICATION_PREFERENCES',
  'REVIEW_INDICATORS',
] as const;

export type SupportOnboardingStepId =
  (typeof SupportOnboardingStepValues)[number];

/** Os sinais que só esta tela pergunta. Os outros vêm do onboarding do `/me`. */
export type SupportOnboardingSignals = {
  /**
   * O nome da organização foi confirmado por um humano **e** existe um dado de
   * contato (CNPJ ou telefone).
   *
   * `nameConfirmedAt` sozinho não basta: toda organização nasce com nome
   * derivado da conta no provisionamento do cadastro, então "tem nome" é
   * verdadeiro desde o primeiro segundo e o passo nasceria concluído sem
   * ninguém ter preenchido nada.
   */
  organizationProfileComplete: boolean;
  /** Existe outra pessoa na organização, ou um convite ainda de pé. */
  teamInvited: boolean;
  /**
   * A tela de notificações foi salva por um humano (`preferences.reviewed_at`).
   *
   * **Não** é "a linha existe": toda conta nasce com uma, criada por
   * `AccountOnboardingService.ensurePreference` para o e-mail com gate de
   * preferência alcançar alguém. Ler a existência da linha marcava este passo
   * como concluído no segundo em que a conta era criada.
   *
   * O carimbo, e não o valor dos booleanos: desligar todos os avisos é
   * configurar, e manter os padrões depois de conferi-los também.
   */
  notificationPreferencesSet: boolean;
};

/** Os sinais de produto, já resolvidos por `OnboardingStatePortInterface`. */
export type SupportOnboardingProductSignals = {
  hasConnectedIntegration: boolean;
  hasLinkedAdAccount: boolean;
  hasSyncedAds: boolean;
};

export type SupportOnboardingChecklistItem = {
  id: SupportOnboardingStepId;
  completed: boolean;
};

export type SupportOnboardingChecklist = {
  steps: SupportOnboardingChecklistItem[];
  completedCount: number;
  totalCount: number;
  /** Inteiro de 0 a 100 — a barra da tela, arredondada no servidor. */
  progress: number;
};

/**
 * Monta o checklist a partir dos dois conjuntos de sinais.
 *
 * Pura: quem toca banco são os adaptadores, e é isto que os testes exercitam.
 * A ordem do array **é** a ordem da tela, e vale a mesma disciplina do
 * onboarding linear — organização antes de convite (não há quem convidar sem
 * ela), integração antes de indicadores (não há o que ver sem ingestão).
 * Diferente de lá, a ordem aqui é sugestão de caminho, não pré-requisito
 * técnico: nada impede concluir o quarto item antes do primeiro.
 */
export function resolveSupportOnboarding(
  signals: SupportOnboardingSignals,
  product: SupportOnboardingProductSignals,
): SupportOnboardingChecklist {
  const completedById: Record<SupportOnboardingStepId, boolean> = {
    ORGANIZATION_PROFILE: signals.organizationProfileComplete,
    INVITE_TEAM: signals.teamInvited,
    // As duas metades da mesma tarefa: credencial conectada sem conta de
    // anúncios vinculada não traz um anúncio sequer, e marcar o passo ali
    // mandaria a pessoa para a próxima etapa achando que terminou esta.
    CONNECT_INTEGRATIONS:
      product.hasConnectedIntegration && product.hasLinkedAdAccount,
    NOTIFICATION_PREFERENCES: signals.notificationPreferencesSet,
    REVIEW_INDICATORS: product.hasSyncedAds,
  };

  const steps = SupportOnboardingStepValues.map((id) => ({
    id,
    completed: completedById[id],
  }));

  const completedCount = steps.filter((step) => step.completed).length;

  return {
    steps,
    completedCount,
    totalCount: steps.length,
    progress: Math.round((completedCount / steps.length) * 100),
  };
}
