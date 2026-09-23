import { Injectable, Logger } from '@nestjs/common';
import { EmailPreferenceGate } from 'src/modules/preferences/application/services/email-preference-gate.service';
import { EmailSenderPortInterface } from 'src/shared/application/ports';
import {
  alertTemplate,
  alertTemplateText,
} from 'src/shared/infrastructure/email/templates';
import {
  AlertDTO,
  AlertsRepositoryInterface,
} from 'src/modules/alerts/domain/ports/alerts.repository';
import {
  AlertSkipReason,
  decideAlertDelivery,
} from 'src/modules/alerts/domain/alert-delivery-policy';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { AlertRecipientResolver } from './alert-recipient.resolver';
import { AppUrlService } from 'src/shared/infrastructure/config/app-url.service';

const SEVERITY_LABEL: Record<string, string> = {
  CRITICAL: 'Critico',
  WARNING: 'Atencao',
  INFO: 'Informativo',
};

const TYPE_LABEL: Record<string, string> = {
  WASTE_DETECTED: 'Desperdicio detectado',
  RECOMMENDATION_GENERATED: 'Nova recomendacao',
  BUDGET_ALERT: 'Orcamento',
  SYSTEM: 'Sistema',
};

export type AlertDeliveryOutcome =
  | { delivered: true }
  | {
      delivered: false;
      reason:
        | AlertSkipReason
        | 'preference_denied'
        | 'send_failed'
        /** O plano não cobre email para alertas desta severidade. */
        | 'plan_severity';
    };

/**
 * Delivers an alert by email (PLAN.md Sprint 6 / M-2).
 *
 * Two independent gates, and an alert must clear both:
 *
 * 1. `decideAlertDelivery` — is this important enough to leave the app for?
 *    (INFO never is; an already-notified or closed alert never is.)
 * 2. `EmailPreferenceGate.canSend(..., 'ALERT')` — does the user allow this category?
 * 3. `planAllowsSeverity` — does the plan cover email for this severity? (Waste
 *    alerts only; integrity alerts reach every plan.)
 *
 * The service **never throws**. An alert that exists in-app but whose email failed is
 * a degraded notification; an exception here would instead fail the pipeline that
 * created it — losing the alert entirely over a mail problem.
 */
@Injectable()
export class AlertNotifierService {
  private readonly logger = new Logger(AlertNotifierService.name);

  constructor(
    private readonly alertsRepository: AlertsRepositoryInterface,
    private readonly preferenceGate: EmailPreferenceGate,
    private readonly emailSender: EmailSenderPortInterface,
    private readonly recipients: AlertRecipientResolver,
    private readonly appUrl: AppUrlService,
    private readonly plans: PlanEntitlementService,
  ) {}

  async notify(alert: AlertDTO): Promise<AlertDeliveryOutcome> {
    try {
      return await this.deliver(alert);
    } catch (error) {
      // Includes a failing recipient lookup or a broken mail provider.
      this.logger.error(
        `alert.delivery_failed alertId=${alert.id} organizationId=${alert.organizationId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { delivered: false, reason: 'send_failed' };
    }
  }

  private async deliver(alert: AlertDTO): Promise<AlertDeliveryOutcome> {
    const recipient = await this.recipients.resolve(alert.organizationId);

    const decision = decideAlertDelivery({
      severity: alert.severity,
      notifiedAt: alert.notifiedAt,
      dismissedAt: alert.dismissedAt,
      resolvedAt: alert.resolvedAt,
      recipientEmail: recipient?.email,
    });

    if (!decision.deliver) {
      // Expected for every INFO alert, so this stays at debug level.
      this.logger.debug(
        `alert.delivery_skipped alertId=${alert.id} reason=${decision.reason}`,
      );
      return { delivered: false, reason: decision.reason };
    }

    if (!(await this.planAllowsSeverity(alert))) {
      this.logger.debug(
        `alert.delivery_skipped alertId=${alert.id} reason=plan_severity`,
      );
      return { delivered: false, reason: 'plan_severity' };
    }

    // The user's choice is checked after severity so a denied preference is not
    // logged for alerts that were never going to be emailed anyway.
    // A preferência é da pessoa que recebe, não da organização: quem decide se
    // quer e-mail é o destinatário resolvido acima.
    const allowed = recipient
      ? await this.preferenceGate.canSend(recipient.accountId, 'ALERT')
      : false;

    if (!allowed) {
      this.logger.log(
        `alert.delivery_skipped alertId=${alert.id} reason=preference_denied`,
      );
      return { delivered: false, reason: 'preference_denied' };
    }

    // `recipient` is non-null here: a missing email is `missing_recipient` above.
    const { email, name } = recipient!;

    const templateProps = {
      name,
      severity: alert.severity as 'WARNING' | 'CRITICAL',
      severityLabel: SEVERITY_LABEL[alert.severity] ?? alert.severity,
      title: alert.title,
      message: alert.message,
      typeLabel: TYPE_LABEL[alert.type] ?? alert.type,
      dateLabel: alert.createdAt.toLocaleDateString('pt-BR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
      }),
      appUrl: this.appUrl.baseUrl,
    };

    await this.emailSender.send({
      to: email,
      subject: `[${SEVERITY_LABEL[alert.severity] ?? alert.severity}] ${alert.title}`,
      html: alertTemplate(templateProps),
      text: alertTemplateText(templateProps),
    });

    // Recorded only after the send succeeds, so a failed send can be retried by a
    // later recurrence instead of being marked as delivered.
    await this.alertsRepository.markNotified(alert.id, new Date());

    this.logger.log(
      `alert.delivered alertId=${alert.id} organizationId=${alert.organizationId} severity=${alert.severity}`,
    );

    return { delivered: true };
  }

  /**
   * O terceiro portão: o plano cobre alertas **desta severidade**?
   *
   * **Só incide sobre `WASTE_DETECTED`.** Os outros tipos são de integridade —
   * integração caída, quarentena de sync, escrita não verificada — e existem
   * para avisar que o produto parou de funcionar direito para aquela conta.
   * Calá-los por plano não venderia upgrade nenhum: esconderia um defeito nosso
   * de quem está pagando para saber dele.
   *
   * O alerta continua sendo criado e aparecendo no app em qualquer plano. O que
   * o plano governa é sair do app e chegar por email.
   */
  private async planAllowsSeverity(alert: AlertDTO): Promise<boolean> {
    if (alert.type !== 'WASTE_DETECTED') return true;

    const state = await this.plans.itemStateFor({
      organizationId: alert.organizationId,
      feature: 'email-waste-alerts',
      item: alert.severity,
    });

    return state.allowed;
  }
}
