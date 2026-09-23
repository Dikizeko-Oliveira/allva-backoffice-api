import { randomUUID } from 'crypto';

/**
 * As escritas que o backoffice-api audita. União fechada pelo mesmo motivo do
 * `AuditEvent` do `allva-api`: a trilha só serve para filtro e alerta se o
 * vocabulário for estável, e uma ação nova sem nome aqui não compila.
 */
export type BackofficeAuditAction =
  | 'internal_note.created'
  | 'internal_note.updated'
  | 'internal_note.deleted'
  | 'contract_draft.created'
  | 'contract_draft.updated'
  | 'contract_draft.converted'
  | 'alert_rule.created'
  | 'alert_rule.updated'
  | 'alert_event.acknowledged'
  | 'operator_preferences.updated'
  | 'saved_view.created'
  | 'saved_view.updated'
  | 'saved_view.deleted'
  | 'support.ticket.assigned'
  | 'support.sla_policy.created'
  | 'support.sla_policy.updated';

type BackofficeAuditLogProps = {
  id: string;
  actorId: string;
  action: BackofficeAuditAction;
  subjectType: string;
  subjectId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
};

export type CreateBackofficeAuditLogProps = {
  actorId: string;
  action: BackofficeAuditAction;
  subjectType: string;
  subjectId: string;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Uma linha da trilha do **processo interno**. Append-only: não há método que
 * altere uma entrada depois de criada.
 *
 * Separada de `audit_logs` do `allva-api` de propósito — lá fica o que
 * aconteceu com o dado do cliente; aqui, o que o time da Allva fez no próprio
 * processo (anotou, atribuiu, reconheceu um alerta).
 */
export class BackofficeAuditLog {
  private constructor(private readonly props: BackofficeAuditLogProps) {}

  static create(props: CreateBackofficeAuditLogProps): BackofficeAuditLog {
    return new BackofficeAuditLog({
      id: randomUUID(),
      actorId: props.actorId,
      action: props.action,
      subjectType: props.subjectType,
      subjectId: props.subjectId,
      before: props.before ?? null,
      after: props.after ?? null,
      reason: props.reason?.trim() || null,
      ip: props.ip ?? null,
      userAgent: props.userAgent ?? null,
      createdAt: new Date(),
    });
  }

  static restore(props: BackofficeAuditLogProps): BackofficeAuditLog {
    return new BackofficeAuditLog(props);
  }

  get id(): string {
    return this.props.id;
  }

  get actorId(): string {
    return this.props.actorId;
  }

  get action(): BackofficeAuditAction {
    return this.props.action;
  }

  get subjectType(): string {
    return this.props.subjectType;
  }

  get subjectId(): string {
    return this.props.subjectId;
  }

  get before(): unknown {
    return this.props.before;
  }

  get after(): unknown {
    return this.props.after;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  get ip(): string | null {
    return this.props.ip;
  }

  get userAgent(): string | null {
    return this.props.userAgent;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
