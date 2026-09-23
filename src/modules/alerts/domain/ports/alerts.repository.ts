/**
 * Os quatro tipos do v1 mais os onze da v2.0 (§4.7). `SYNC_QUARANTINE` e
 * `AD_ARCHIVE_SUPPRESSED` são sobre a **conta**, não sobre um anúncio — é por
 * eles que o alerta precisa de seis sujeitos possíveis, e não cinco.
 */
export type AlertType =
  | 'WASTE_DETECTED'
  | 'RECOMMENDATION_GENERATED'
  | 'BUDGET_ALERT'
  | 'SYSTEM'
  | 'AD_SCORE_DROPPED'
  | 'AD_DRIFT_DETECTED'
  | 'ACTION_FAILED'
  | 'ACTION_VERIFIED'
  | 'INTEGRATION_DISCONNECTED'
  | 'AD_ARCHIVE_SUPPRESSED'
  | 'SYNC_QUARANTINE'
  | 'UNVERIFIED_WRITE'
  | 'DENORMALIZATION_DRIFT'
  | 'AI_BUDGET_EXCEEDED'
  | 'PARTITION_MARGIN_LOW'
  /** Uma escrita criou entidade e não terminou — ver `exposureRisk`. */
  | 'ACTION_PARTIALLY_COMPLETED';

export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/** Lifecycle filter for listing (Sprint 6 / M-2). */
export type AlertState = 'OPEN' | 'DISMISSED' | 'RESOLVED' | 'ALL';

/**
 * O sujeito do alerta: **exatamente um**, com FK real.
 *
 * O v1 usava `referenceType`/`referenceId` — associação polimórfica por string —
 * e o worker de waste passava o tipo sem nunca passar o id. O alerta nascia
 * apontando para lugar nenhum, e nada no banco impedia. Aqui o conjunto é
 * fechado, cada opção é uma FK, e um `CHECK` de exclusividade recusa a linha que
 * não declare exatamente um sujeito.
 */
export type AlertSubject =
  | { kind: 'AD'; adId: string }
  | { kind: 'AD_ACCOUNT'; adAccountId: string }
  | { kind: 'WASTE_ITEM'; wasteItemId: string }
  | { kind: 'RECOMMENDATION'; recommendationId: string }
  | { kind: 'ACTION_EXECUTION'; actionExecutionId: string }
  | { kind: 'INTEGRATION'; integrationId: string };

export type CreateAlertInput = {
  /** NOT NULL desde a v2.0: alerta é da organização, não da conta pessoal. */
  organizationId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  subject: AlertSubject;
  correlationId?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type AlertDTO = {
  id: string;
  organizationId: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  subject: AlertSubject;
  /** Derivado de `readAt`: o v2.0 não guarda o booleano, que divergia da data. */
  isRead: boolean;
  readAt: Date | null;
  dismissedAt: Date | null;
  resolvedAt: Date | null;
  notifiedAt: Date | null;
  occurrences: number;
  /**
   * Timestamps de DOMÍNIO. `updatedAt` não serve de última ocorrência: é
   * `@updatedAt` e bumpa ao marcar como lido, o que faria o produto reportar
   * "última ocorrência: agora" para uma condição que não recorre há uma semana.
   */
  firstOccurredAt: Date;
  lastOccurredAt: Date;
  createdAt: Date;
};

export type AlertListQuery = {
  organizationId: string;
  isRead?: boolean;
  severity?: AlertSeverity;
  /**
   * Defaults to `OPEN` — a dismissed or resolved alert is not what someone opening
   * the panel wants to see first.
   */
  state?: AlertState;
  limit?: number;
  page?: number;
};

/**
 * Result of `createOrRecur`. Distinguishing the two cases is what lets the caller
 * notify once per problem instead of once per detection run.
 */
export type AlertUpsertResult = {
  alert: AlertDTO;
  /** `false` when an open alert with the same fingerprint already existed. */
  created: boolean;
};

export abstract class AlertsRepositoryInterface {
  /**
   * Creates the alert, or records a recurrence of the open alert carrying the same
   * fingerprint (bumping `occurrences` and `lastOccurredAt`).
   *
   * Deduplication exists because detection runs daily and re-reports the same
   * persistent condition on every run. Without it the list grows without bound and
   * a new email would go out every morning for a problem already reported.
   */
  abstract createOrRecur(
    input: CreateAlertInput & { fingerprint: string },
  ): Promise<AlertUpsertResult>;

  abstract list(
    query: AlertListQuery,
  ): Promise<{ data: AlertDTO[]; total: number }>;

  /** Single alert, scoped to the organization — the detail screen's read. */
  abstract findById(
    id: string,
    organizationId: string,
  ): Promise<AlertDTO | null>;

  abstract markRead(
    id: string,
    organizationId: string,
  ): Promise<AlertDTO | null>;

  abstract markAllRead(organizationId: string): Promise<number>;

  /** User hides the alert. Idempotent: dismissing twice keeps the first timestamp. */
  abstract dismiss(
    id: string,
    organizationId: string,
  ): Promise<AlertDTO | null>;

  /**
   * The underlying condition ended ("encerramento"). Idempotent. A later recurrence
   * of the same fingerprint creates a *new* alert, because the problem came back.
   */
  abstract resolve(
    id: string,
    organizationId: string,
  ): Promise<AlertDTO | null>;

  /** Records that an email went out, so recurrences do not re-notify. */
  abstract markNotified(id: string, at: Date): Promise<void>;
}
