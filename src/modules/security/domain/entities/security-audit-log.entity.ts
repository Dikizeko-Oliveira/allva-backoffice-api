import { randomUUID } from 'crypto';

/**
 * Canonical, closed set of security events. Mirrors the business `AuditEvent`
 * union but is dedicated to security-relevant signals so brute-force counters
 * and security dashboards can rely on a stable vocabulary.
 */
export type SecurityEvent =
  | 'login.failed'
  | 'login.blocked'
  | 'password.reset.requested'
  | 'password.reset.failed'
  | 'invitation.failed'
  | 'email_verification.failed'
  | 'brute_force.detected'
  | 'suspicious_activity'
  | 'session.revoked'
  | 'token.replay.detected'
  /**
   * A2-S7 — os controles que decidem se a Allva pode escrever em mídia paga.
   *
   * Estão na trilha de **segurança**, e não só na de negócio, porque a pergunta
   * que se faz sobre eles num incidente é de segurança: quem autorizou, de que
   * IP, quando — e quem religou o kill switch às três da manhã.
   */
  | 'platform_write.consent_granted'
  | 'platform_write.consent_revoked'
  | 'platform_write.kill_switch_toggled'
  /**
   * §13.5 entrega 15 — **toda execução gera `AuditLog` e `SecurityAuditLog`.**
   *
   * Não é redundância. As duas trilhas respondem perguntas diferentes e têm
   * retenções diferentes: a de negócio responde *"o que aconteceu com este
   * anúncio?"* e a de segurança responde *"quem, de onde, e o que mais essa
   * conta fez naquela janela?"*. Investigar um incidente pela primeira exige
   * cruzar por `entityId` uma trilha que não guarda IP nem sessão.
   */
  | 'platform_write.executed'
  | 'platform_write.failed';

export type SecuritySeverity = 'info' | 'warning' | 'critical';

type CreateSecurityAuditLogProps = {
  event: SecurityEvent;
  severity?: SecuritySeverity;
  accountId?: string | null;
  organizationId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  metadata?: Record<string, unknown> | null;
};

type RestoreSecurityAuditLogProps = CreateSecurityAuditLogProps & {
  id: string;
  severity: SecuritySeverity;
  createdAt: Date;
};

export class SecurityAuditLog {
  private _id: string;
  private _event: SecurityEvent;
  private _severity: SecuritySeverity;
  private _accountId: string | null;
  private _organizationId: string | null;
  private _ipAddress: string | null;
  private _userAgent: string | null;
  private _metadata: Record<string, unknown> | null;
  private _createdAt: Date;

  private constructor(props: RestoreSecurityAuditLogProps) {
    this._id = props.id;
    this._event = props.event;
    this._severity = props.severity;
    this._accountId = props.accountId ?? null;
    this._organizationId = props.organizationId ?? null;
    this._ipAddress = props.ipAddress ?? null;
    this._userAgent = props.userAgent ?? null;
    this._metadata = props.metadata ?? null;
    this._createdAt = props.createdAt;
  }

  static create(props: CreateSecurityAuditLogProps): SecurityAuditLog {
    return new SecurityAuditLog({
      ...props,
      id: randomUUID(),
      severity: props.severity ?? 'info',
      createdAt: new Date(),
    });
  }

  static restore(props: RestoreSecurityAuditLogProps): SecurityAuditLog {
    return new SecurityAuditLog(props);
  }

  get id() {
    return this._id;
  }

  get event() {
    return this._event;
  }

  get severity() {
    return this._severity;
  }

  get accountId() {
    return this._accountId;
  }

  get organizationId() {
    return this._organizationId;
  }

  get ipAddress() {
    return this._ipAddress;
  }

  get userAgent() {
    return this._userAgent;
  }

  get metadata() {
    return this._metadata;
  }

  get createdAt() {
    return this._createdAt;
  }
}
