import { AlertSeverity, AlertSubject } from './ports/alerts.repository';

/**
 * Decides whether an alert earns an email (PLAN.md Sprint 6 / M-2).
 *
 * Pure and preference-agnostic on purpose: the *preference* half of the decision
 * lives in `isEmailCategoryAllowed` (preferences domain), and the caller must pass
 * both gates. Splitting them keeps "does the user allow this category" separate
 * from "is this alert important enough to interrupt someone".
 */

/** Severities that justify leaving the app to reach someone. */
const NOTIFIABLE_SEVERITIES: ReadonlySet<AlertSeverity> =
  new Set<AlertSeverity>(['WARNING', 'CRITICAL']);

export type AlertDeliveryDecision =
  | { deliver: true }
  | { deliver: false; reason: AlertSkipReason };

export type AlertSkipReason =
  /** INFO is in-app only — emailing it would train users to ignore alerts. */
  | 'severity_below_threshold'
  /** Already emailed. Recurrences of the same open alert must not re-notify. */
  | 'already_notified'
  /** Nothing to interrupt anyone about: the alert arrived already closed. */
  | 'alert_not_open'
  /** The account has no address to send to. */
  | 'missing_recipient';

export type AlertDeliveryInput = {
  severity: AlertSeverity;
  /** Set once an email went out for this alert. */
  notifiedAt?: Date | null;
  dismissedAt?: Date | null;
  resolvedAt?: Date | null;
  recipientEmail?: string | null;
};

/**
 * The severity half of the decision. Deliberately does **not** consider
 * preferences — a caller that skips the preference gate is a bug the gate itself
 * should catch, not something this function can paper over.
 */
export function decideAlertDelivery(
  input: AlertDeliveryInput,
): AlertDeliveryDecision {
  if (!input.recipientEmail?.trim()) {
    return { deliver: false, reason: 'missing_recipient' };
  }

  // An alert created already dismissed or resolved (e.g. a backfill) has nothing
  // to announce.
  if (input.dismissedAt || input.resolvedAt) {
    return { deliver: false, reason: 'alert_not_open' };
  }

  if (input.notifiedAt) {
    return { deliver: false, reason: 'already_notified' };
  }

  if (!NOTIFIABLE_SEVERITIES.has(input.severity)) {
    return { deliver: false, reason: 'severity_below_threshold' };
  }

  return { deliver: true };
}

/**
 * Identidade estável de "o mesmo problema, reportado de novo".
 *
 * A detecção re-reporta uma condição persistente a cada execução diária. Agrupar
 * pelo **sujeito tipado** — o par (tipo do sujeito, id) — colapsa essas execuções
 * num alerta só. O `title` entra apenas quando o sujeito é a conta ou a
 * integração, onde ele é a única coisa que distingue dois alertas do mesmo tipo.
 *
 * O v1 usava `referenceType`/`referenceId` como strings livres, e o alerta órfão
 * nascia justamente aqui: `referenceType` preenchido, `referenceId` nulo, e o
 * fingerprint colapsando alertas de anúncios diferentes num só.
 */
export function alertFingerprint(input: {
  organizationId: string;
  type: string;
  subject: AlertSubject;
  title: string;
}): string {
  const [subjectKind, subjectId] = describeSubject(input.subject);

  return [
    input.organizationId,
    input.type,
    subjectKind,
    subjectId,
    // Só distingue quando o sujeito é amplo demais para agrupar sozinho.
    subjectKind === 'AD_ACCOUNT' || subjectKind === 'INTEGRATION'
      ? input.title.trim().toLowerCase()
      : '-',
  ].join('|');
}

function describeSubject(subject: AlertSubject): [string, string] {
  switch (subject.kind) {
    case 'AD':
      return ['AD', subject.adId];
    case 'AD_ACCOUNT':
      return ['AD_ACCOUNT', subject.adAccountId];
    case 'WASTE_ITEM':
      return ['WASTE_ITEM', subject.wasteItemId];
    case 'RECOMMENDATION':
      return ['RECOMMENDATION', subject.recommendationId];
    case 'ACTION_EXECUTION':
      return ['ACTION_EXECUTION', subject.actionExecutionId];
    case 'INTEGRATION':
      return ['INTEGRATION', subject.integrationId];
  }
}
