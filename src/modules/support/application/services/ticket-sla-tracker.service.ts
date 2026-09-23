import { Injectable } from '@nestjs/common';
import { TicketSlaSnapshot } from 'src/modules/support/domain/entities';
import {
  ProductSupportTicket,
  SlaPoliciesRepositoryInterface,
  TicketSlaSnapshotsRepositoryInterface,
} from 'src/modules/support/domain/ports';
import { resolveSlaTargets } from 'src/modules/support/domain/sla';
import { SupportTicketOutputDto } from '../dtos';
import { toSupportTicketOutput } from '../support.presenter';

/**
 * Cada vez que o backoffice-api vê um chamado do produto, o SLA dele é
 * atualizado — é assim que `ticket_sla_snapshots` acompanha o produto sem
 * webhook. Compartilhado pela fila, pelo detalhe e pela atribuição.
 *
 * Uma página inteira custa três consultas (políticas, snapshots existentes,
 * gravação), não três por chamado.
 */
@Injectable()
export class TicketSlaTrackerService {
  constructor(
    private readonly policiesRepository: SlaPoliciesRepositoryInterface,
    private readonly snapshotsRepository: TicketSlaSnapshotsRepositoryInterface,
  ) {}

  async track(
    tickets: readonly ProductSupportTicket[],
    now: Date = new Date(),
  ): Promise<SupportTicketOutputDto[]> {
    if (tickets.length === 0) return [];

    const [policies, existing] = await Promise.all([
      this.policiesRepository.listActive(),
      this.snapshotsRepository.findByTicketIds(
        tickets.map((ticket) => ticket.facts.id),
      ),
    ]);

    const snapshots = tickets.map(({ facts }) => {
      const snapshot = existing.get(facts.id);

      if (!snapshot) {
        return TicketSlaSnapshot.open(
          facts,
          resolveSlaTargets(policies, facts.priority, facts.category),
        );
      }

      snapshot.observe(facts, now);
      return snapshot;
    });

    await this.snapshotsRepository.saveMany(snapshots);

    return tickets.map((ticket, index) =>
      toSupportTicketOutput(ticket, snapshots[index], now),
    );
  }
}
