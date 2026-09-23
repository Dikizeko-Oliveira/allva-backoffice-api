import { Injectable, Logger } from '@nestjs/common';
import { Account } from 'src/modules/accounts/domain/entities';
import { Preference } from 'src/modules/preferences/domain/entities';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { OrganizationProvisioningService } from 'src/modules/provisioning/application/organization-provisioning.service';
import {
  EmailSenderPortInterface,
  EmailTemplateRendererPortInterface,
} from 'src/shared/application/ports';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';

/**
 * Side effects every new account must get, regardless of how it signed up
 * (password, Google, Facebook, enterprise provisioning).
 *
 * Creating the Preference row here is what makes preference-gated email reach
 * new users at all — the daily summary only considers accounts that have one
 * (M-7). None of these steps may break signup, so each is best-effort: a failed
 * welcome email must never cost the user their account.
 *
 * A organização entrou nesta lista porque o produto é organization-first e o
 * cadastro não era: sem ela a conta nasce num estado que nenhuma tela sabe
 * atender. Ela segue a mesma regra best-effort das outras, e a razão é a
 * assimetria dos desfechos — a conta já foi gravada quando este serviço roda,
 * então propagar o erro trocaria "organização faltando" por "conta existente
 * que não consegue cadastrar de novo", irrecuperável sem suporte.
 *
 * O que torna essa escolha aceitável é a organização ser garantida de novo
 * onde a falta é fatal: `CreateIntegrationUseCase` chama o mesmo serviço antes
 * de gravar a credencial, e `provision:organizations` cura o que ficou para
 * trás. A falha aqui atrasa a organização; não a perde.
 */
@Injectable()
export class AccountOnboardingService {
  private readonly logger = new Logger(AccountOnboardingService.name);

  constructor(
    private readonly preferencesRepository: PreferencesRepositoryInterface,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly emailTemplates: EmailTemplateRendererPortInterface,
    private readonly appUrl: AppUrlService,
    private readonly organizationProvisioning: OrganizationProvisioningService,
  ) {}

  async execute(
    account: Account,
    options: { sendWelcomeEmail?: boolean } = {},
  ): Promise<void> {
    await this.ensurePreference(account.id);
    await this.ensureOrganization(account);

    if (options.sendWelcomeEmail) {
      await this.sendWelcomeEmail(account);
    }
  }

  /** Idempotent: signing up twice (or re-running provisioning) creates one row. */
  async ensurePreference(accountId: string): Promise<void> {
    try {
      const existing =
        await this.preferencesRepository.findByAccountId(accountId);

      if (existing) return;

      await this.preferencesRepository.save(Preference.create({ accountId }));
    } catch (error) {
      this.logger.error(
        `onboarding.preference_failed accountId=${accountId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * A organização que o resto do produto pressupõe. Idempotente: quem chegou por
   * convite reusa a organização de quem convidou, em vez de ganhar uma vazia.
   *
   * Roda duas vezes por cadastro — na criação da conta e de novo na confirmação
   * do e-mail —, e é a idempotência que torna isso inofensivo: a segunda
   * chamada encontra a organização da primeira e não decide plano nenhum.
   */
  async ensureOrganization(account: Account): Promise<void> {
    try {
      await this.organizationProvisioning.ensureForAccount({
        accountId: account.id,
        accountName: account.name,
        accountEmail: account.email,
        source: 'signup',
        // O plano escolhido na landing, gravado na conta pelo cadastro. É o que
        // decide se a organização nasce no teste gratuito ou esperando o
        // primeiro pagamento; sem ele, quem escolheu o Profissional nascia
        // `TRIALING` e o checkout da primeira assinatura o expulsava.
        selectedPlanId: account.selectedPlanId,
      });
    } catch (error) {
      this.logger.error(
        `onboarding.organization_failed accountId=${account.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Account-lifecycle mail, so it is TRANSACTIONAL and not preference-gated —
   * it is sent once, at the moment the user asked for an account.
   */
  private async sendWelcomeEmail(account: Account): Promise<void> {
    try {
      const { subject, html, text } = await this.emailTemplates.render(
        'welcome',
        {
          name: account.name,
          appUrl: this.appUrl.baseUrl,
        },
      );

      await this.emailSender.send({ to: account.email, subject, html, text });
    } catch (error) {
      this.logger.error(
        `onboarding.welcome_email_failed accountId=${account.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
