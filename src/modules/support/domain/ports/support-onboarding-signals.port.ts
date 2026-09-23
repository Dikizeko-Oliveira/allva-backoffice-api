import { SupportOnboardingSignals } from '../support-onboarding';

/**
 * Os três sinais do checklist que vivem em tabelas de outros módulos —
 * `organizations`, `organization_users`/`organization_invitations` e
 * `preferences`.
 *
 * Port, e não import dos módulos correspondentes, pela mesma razão de
 * `OnboardingStatePortInterface`: o contrato pertence a quem pergunta, a
 * leitura mora no adaptador. Importar `PreferencesModule` aqui traria um
 * módulo inteiro de escrita para responder a um booleano.
 */
export abstract class SupportOnboardingSignalsPortInterface {
  abstract readSignals(input: {
    organizationId: string;
    accountId: string;
  }): Promise<SupportOnboardingSignals>;
}
