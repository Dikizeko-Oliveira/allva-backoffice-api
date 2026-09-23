import { randomUUID } from 'crypto';

type TicketAssignmentEventProps = {
  id: string;
  ticketId: string;
  fromOperatorId: string | null;
  toOperatorId: string | null;
  actorId: string;
  reason: string | null;
  createdAt: Date;
};

export type CreateTicketAssignmentEventProps = Omit<
  TicketAssignmentEventProps,
  'id' | 'createdAt'
>;

/**
 * Quem passou o chamado para quem, e por quê. Append-only.
 *
 * O `allva-api` guarda só o responsável **atual**; o histórico de repasses é
 * processo interno e mora aqui.
 */
export class TicketAssignmentEvent {
  private constructor(private readonly props: TicketAssignmentEventProps) {}

  static create(
    props: CreateTicketAssignmentEventProps,
  ): TicketAssignmentEvent {
    return new TicketAssignmentEvent({
      ...props,
      reason: props.reason?.trim() || null,
      id: randomUUID(),
      createdAt: new Date(),
    });
  }

  get id(): string {
    return this.props.id;
  }

  get ticketId(): string {
    return this.props.ticketId;
  }

  get fromOperatorId(): string | null {
    return this.props.fromOperatorId;
  }

  get toOperatorId(): string | null {
    return this.props.toOperatorId;
  }

  get actorId(): string {
    return this.props.actorId;
  }

  get reason(): string | null {
    return this.props.reason;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }
}
