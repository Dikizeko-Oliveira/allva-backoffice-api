import type { TicketSlaSnapshot } from '../entities';

export type SlaComplianceFilter = {
  from?: Date;
  to?: Date;
  assigneeId?: string;
};

export type SlaCompliance = {
  /** Chamados abertos no período. */
  total: number;
  /** Desses, os resolvidos depois do prazo de resolução. */
  breached: number;
};

export abstract class TicketSlaSnapshotsRepositoryInterface {
  abstract findByTicketIds(
    ticketIds: readonly string[],
  ): Promise<Map<string, TicketSlaSnapshot>>;
  /** Grava o estado atual — cria na primeira vez, sobrescreve depois. */
  abstract saveMany(snapshots: readonly TicketSlaSnapshot[]): Promise<void>;
  abstract compliance(filter: SlaComplianceFilter): Promise<SlaCompliance>;
}
