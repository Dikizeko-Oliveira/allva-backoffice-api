import { Injectable, NotFoundException } from '@nestjs/common';
import { EmailTemplateRendererPortInterface } from 'src/shared/application/ports/email-template-renderer.port';
import {
  alertTemplate,
  alertTemplateText,
  dailySummaryTemplate,
  dailySummaryTemplateText,
  emailVerificationTemplate,
  emailVerificationTemplateText,
  forgotPasswordTemplate,
  forgotPasswordTemplateText,
  organizationInvitationTemplate,
  organizationInvitationTemplateText,
  passwordChangedTemplate,
  passwordChangedTemplateText,
  reportReadyTemplate,
  reportReadyTemplateText,
  supportRequestTemplate,
  supportRequestTemplateText,
  supportConfirmationTemplate,
  supportConfirmationTemplateText,
  welcomeTemplate,
  welcomeTemplateText,
} from 'src/shared/infrastructure/email/templates';

type TemplateEntry = {
  subject: string;
  render: (props: any) => string;
  renderText: (props: any) => string;
};

@Injectable()
export class SimpleEmailTemplateRendererProvider implements EmailTemplateRendererPortInterface {
  private readonly templates: Record<string, TemplateEntry> = {
    'forgot-password': {
      subject: 'Reset your password',
      render: forgotPasswordTemplate,
      renderText: forgotPasswordTemplateText,
    },
    'password-changed': {
      subject: 'Your password has been changed',
      render: passwordChangedTemplate,
      renderText: passwordChangedTemplateText,
    },
    'organization-invitation': {
      subject: 'Convite para participar da organização na Allva',
      render: organizationInvitationTemplate,
      renderText: organizationInvitationTemplateText,
    },
    'email-verification': {
      subject: 'Confirme seu email',
      render: emailVerificationTemplate,
      renderText: emailVerificationTemplateText,
    },
    welcome: {
      subject: 'Bem-vindo a Allva',
      render: welcomeTemplate,
      renderText: welcomeTemplateText,
    },
    alert: {
      subject: 'Alerta Allva',
      render: alertTemplate,
      renderText: alertTemplateText,
    },
    'daily-summary': {
      subject: 'Allva — Resumo do dia',
      render: dailySummaryTemplate,
      renderText: dailySummaryTemplateText,
    },
    'report-ready': {
      subject: 'Seu relatório Allva está pronto',
      render: reportReadyTemplate,
      renderText: reportReadyTemplateText,
    },
    /**
     * `subject` aqui nunca chega a um usuário: `SendSupportMessageUseCase`
     * ignora este valor e monta `[Suporte Allva] {assunto informado}` na hora
     * de chamar `EmailSenderPortInterface.send` — a mensagem vai para
     * `ALLVA_SUPPORT_EMAIL`, com o assunto que o próprio usuário escreveu.
     */
    'support-request': {
      subject: 'Nova solicitação de suporte',
      render: supportRequestTemplate,
      renderText: supportRequestTemplateText,
    },
    /**
     * Vai para o usuário, não para o suporte — ver o comentário no template.
     * `SendSupportMessageUseCase` também sobrescreve este `subject`.
     */
    'support-confirmation': {
      subject: 'Recebemos sua mensagem — Suporte Allva',
      render: supportConfirmationTemplate,
      renderText: supportConfirmationTemplateText,
    },
  };

  render<TProps = unknown>(
    templateName: string,
    props: TProps,
  ): Promise<{ subject: string; html: string; text: string }> {
    const template = this.templates[templateName];

    if (!template) {
      throw new NotFoundException(`Template ${templateName} not found`);
    }

    return Promise.resolve({
      subject: template.subject,
      html: template.render(props),
      text: template.renderText(props),
    });
  }
}
