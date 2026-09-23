import { SecurityAuditLog, SecurityEvent } from '../entities';

export type CountByEventParams = {
  event: SecurityEvent;
  since: Date;
  ipAddress?: string | null;
  accountId?: string | null;
};

export type DistinctIpCountParams = {
  accountId: string;
  since: Date;
};

export abstract class SecurityAuditLogsRepositoryInterface {
  abstract save(log: SecurityAuditLog): Promise<void>;

  /**
   * Counts security events matching the given event name within a time window.
   * Optional ipAddress / accountId narrow the count to a specific actor. This is
   * the primitive that powers progressive brute-force lockout.
   */
  abstract countByEventSince(params: CountByEventParams): Promise<number>;

  /**
   * Number of distinct source IPs that produced events for an account within a
   * window — used by suspicious-activity detection (impossible-travel style).
   */
  abstract distinctIpCountByAccountSince(
    params: DistinctIpCountParams,
  ): Promise<number>;
}
