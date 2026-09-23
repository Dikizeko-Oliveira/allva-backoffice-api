import type { TicketAssignmentEvent } from '../entities';

export type AssignmentVolumeFilter = {
  from?: Date;
  to?: Date;
  toOperatorId?: string;
};

export abstract class TicketAssignmentEventsRepositoryInterface {
  abstract save(event: TicketAssignmentEvent): Promise<void>;
  abstract count(filter: AssignmentVolumeFilter): Promise<number>;
}
