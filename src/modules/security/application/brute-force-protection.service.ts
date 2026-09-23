import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { SecurityEvent } from 'src/modules/security/domain/entities';
import { SecurityAuditLogsRepositoryInterface } from 'src/modules/security/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SecurityAuditLogService } from './security-audit-log.service';

export type BruteForceScope =
  | 'login'
  | 'password_reset'
  | 'invitation_accept'
  | 'email_verification';

export type BruteForceKey = {
  scope: BruteForceScope;
  ipAddress?: string | null;
  /**
   * Optional secondary identifier (e.g. the submitted email) so that lockout can
   * be keyed per-account-per-IP rather than purely per-IP. It never identifies
   * whether the account exists — it is only used as a counting dimension.
   */
  accountKey?: string | null;
  userAgent?: string | null;
  accountId?: string | null;
};

type Tier = {
  /** Number of failures within `windowSeconds` that triggers a lockout. */
  threshold: number;
  /** Lockout window / cooldown, in seconds. */
  windowSeconds: number;
};

type ScopeConfig = {
  failureEvent: SecurityEvent;
  blockEvent: SecurityEvent;
  // Ordered ascending by threshold. The longest tripped tier wins.
  tiers: Tier[];
};

const MINUTE = 60;
const HOUR = 60 * MINUTE;

// Progressive lockout tiers, matching the Sprint 6 spec:
//   5 failures  -> 5 min cooldown
//   10 failures -> 30 min cooldown
//   20 failures -> 24h cooldown
const LOGIN_TIERS: Tier[] = [
  { threshold: 5, windowSeconds: 5 * MINUTE },
  { threshold: 10, windowSeconds: 30 * MINUTE },
  { threshold: 20, windowSeconds: 24 * HOUR },
];

// Token-guessing scopes (reset / invitation) get a single aggressive tier.
const TOKEN_TIERS: Tier[] = [
  { threshold: 10, windowSeconds: 10 * MINUTE },
  { threshold: 30, windowSeconds: HOUR },
];

const SCOPES: Record<BruteForceScope, ScopeConfig> = {
  login: {
    failureEvent: 'login.failed',
    blockEvent: 'login.blocked',
    tiers: LOGIN_TIERS,
  },
  password_reset: {
    failureEvent: 'password.reset.failed',
    blockEvent: 'brute_force.detected',
    tiers: TOKEN_TIERS,
  },
  invitation_accept: {
    failureEvent: 'invitation.failed',
    blockEvent: 'brute_force.detected',
    tiers: TOKEN_TIERS,
  },
  /**
   * Confirmação de email por código de 6 dígitos.
   *
   * Entra aqui, e não nos tiers de login, porque é adivinhação de segredo curto
   * — a mesma família de `password_reset`. O código já tem teto próprio de 5
   * tentativas, mas o teto morre a cada reenvio: é este bloqueio que impede o
   * ciclo "reenvia, chuta cinco, reenvia" de varrer o espaço.
   */
  email_verification: {
    failureEvent: 'email_verification.failed',
    blockEvent: 'brute_force.detected',
    tiers: TOKEN_TIERS,
  },
};

/**
 * Progressive, DB-backed brute-force protection. The security audit trail is the
 * counter store: failures are counted directly from `security_audit_logs` within
 * each tier's window, so escalating cooldowns (which fixed-window throttlers
 * cannot express) come for free with no extra infrastructure.
 */
@Injectable()
export class BruteForceProtectionService {
  constructor(
    private readonly repository: SecurityAuditLogsRepositoryInterface,
    private readonly securityAuditLog: SecurityAuditLogService,
    private readonly env: EnvService,
  ) {}

  private get enabled(): boolean {
    // Defaults to enabled; can be turned off for local/dev or tests.
    return this.env.get('SECURITY_BRUTE_FORCE_ENABLED') !== false;
  }

  /**
   * Throws 429 when the key has tripped a lockout tier. Evaluates tiers from the
   * largest threshold down so the longest applicable cooldown wins, and records a
   * block event when it fires.
   */
  async assertNotLocked(key: BruteForceKey): Promise<void> {
    if (!this.enabled || !key.ipAddress) return;

    const config = SCOPES[key.scope];

    for (let i = config.tiers.length - 1; i >= 0; i -= 1) {
      const tier = config.tiers[i];
      const since = new Date(Date.now() - tier.windowSeconds * 1000);

      const failures = await this.repository.countByEventSince({
        event: config.failureEvent,
        ipAddress: key.ipAddress,
        since,
      });

      if (failures >= tier.threshold) {
        await this.securityAuditLog.record({
          event: config.blockEvent,
          severity: 'critical',
          ipAddress: key.ipAddress,
          userAgent: key.userAgent,
          accountId: key.accountId,
          metadata: {
            scope: key.scope,
            failures,
            threshold: tier.threshold,
            windowSeconds: tier.windowSeconds,
          },
        });

        throw new HttpException(
          {
            code: 'ACCOUNT_TEMPORARILY_LOCKED',
            message: 'Too many attempts. Please wait before trying again.',
            retryAfterSeconds: tier.windowSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * Records a failed attempt for the scope. The recorded row is exactly what
   * `assertNotLocked` counts on the next request.
   */
  async registerFailure(key: BruteForceKey): Promise<void> {
    if (!this.enabled) return;

    const config = SCOPES[key.scope];

    await this.securityAuditLog.record({
      event: config.failureEvent,
      severity: 'warning',
      ipAddress: key.ipAddress,
      userAgent: key.userAgent,
      accountId: key.accountId,
      metadata: {
        scope: key.scope,
        // accountKey is a coarse counting dimension, never the secret itself.
        accountKey: key.accountKey ?? undefined,
      },
    });
  }
}
