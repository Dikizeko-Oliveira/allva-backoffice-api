import {
  addMinutes,
  isLiveTicketStatus,
  SlaState,
  slaStateOf,
  SlaTargets,
} from '../sla';

/**
 * O que o backoffice-api sabe de um chamado do produto num dado momento. Vem
 * do `allva-api` (`SupportTicketsGatewayInterface`), nunca de formulário.
 *
 * `messages: null` significa "a resposta não trouxe mensagens" — a listagem do
 * produto não traz, só o detalhe. É diferente de `[]` (chamado sem mensagem), e
 * a diferença decide se os fatos derivados das mensagens podem ser atualizados.
 */
export type ObservedTicket = {
  id: string;
  status: string;
  priority: string;
  category: string | null;
  assigneeId: string | null;
  createdAt: Date;
  lastMessageAt: Date;
  resolvedAt: Date | null;
  messages: readonly { kind: string; createdAt: Date }[] | null;
};

type TicketSlaSnapshotProps = {
  ticketId: string;
  priority: string;
  category: string | null;
  status: string;
  assigneeId: string | null;
  openedAt: Date;
  lastMessageAt: Date;
  lastMessageKind: string | null;
  dueFirstResponseAt: Date | null;
  dueResolutionAt: Date | null;
  firstOperatorReplyAt: Date | null;
  resolvedAt: Date | null;
  escalatedAt: Date | null;
  escalatedTo: string | null;
  escalatedAcknowledgedAt: Date | null;
  updatedAt: Date;
};

export type TicketSlaView = {
  state: SlaState;
  dueFirstResponseAt: Date | null;
  dueResolutionAt: Date | null;
  nextDueAt: Date | null;
  firstOperatorReplyAt: Date | null;
};

const OPERATOR_MESSAGE_KIND = 'OPERATOR';

/**
 * O SLA de um chamado, mantido pelo backoffice-api.
 *
 * ## Prazos são fixados na abertura
 *
 * `open` calcula os vencimentos com a política vigente naquele momento, e
 * `observe` não os recalcula: mudar a política amanhã não pode transformar em
 * "estourado" um chamado que foi aberto sob outra regra.
 */
export class TicketSlaSnapshot {
  private constructor(private props: TicketSlaSnapshotProps) {}

  static open(ticket: ObservedTicket, targets: SlaTargets): TicketSlaSnapshot {
    const snapshot = new TicketSlaSnapshot({
      ticketId: ticket.id,
      priority: ticket.priority,
      category: ticket.category,
      status: ticket.status,
      assigneeId: ticket.assigneeId,
      openedAt: ticket.createdAt,
      lastMessageAt: ticket.lastMessageAt,
      lastMessageKind: null,
      dueFirstResponseAt: addMinutes(
        ticket.createdAt,
        targets.firstResponseMinutes,
      ),
      dueResolutionAt: addMinutes(ticket.createdAt, targets.resolutionMinutes),
      firstOperatorReplyAt: null,
      resolvedAt: null,
      escalatedAt: null,
      escalatedTo: null,
      escalatedAcknowledgedAt: null,
      updatedAt: new Date(),
    });

    snapshot.observe(ticket);
    return snapshot;
  }

  static restore(props: TicketSlaSnapshotProps): TicketSlaSnapshot {
    return new TicketSlaSnapshot(props);
  }

  /** Atualiza o que o produto diz agora sobre o chamado. */
  observe(ticket: ObservedTicket, now: Date = new Date()): void {
    const props = this.props;

    props.priority = ticket.priority;
    props.category = ticket.category;
    props.status = ticket.status;
    props.assigneeId = ticket.assigneeId;
    props.lastMessageAt = ticket.lastMessageAt;

    if (ticket.messages !== null) {
      const byTime = [...ticket.messages].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
      );
      const firstOperatorReply = byTime.find(
        (message) => message.kind === OPERATOR_MESSAGE_KIND,
      );

      // A primeira resposta é um fato histórico: uma vez registrada, não muda.
      props.firstOperatorReplyAt ??= firstOperatorReply?.createdAt ?? null;
      props.lastMessageKind = byTime.at(-1)?.kind ?? props.lastMessageKind;
    }

    if (isLiveTicketStatus(ticket.status)) {
      // Reaberto: volta a correr contra o prazo de resolução.
      props.resolvedAt = null;
    } else {
      props.resolvedAt ??= ticket.resolvedAt ?? now;
    }

    props.updatedAt = now;
  }

  slaView(now: Date = new Date()): TicketSlaView {
    const { dueFirstResponseAt, dueResolutionAt, firstOperatorReplyAt } =
      this.props;
    const live = isLiveTicketStatus(this.props.status);

    const pending = [
      live && !firstOperatorReplyAt ? dueFirstResponseAt : null,
      live ? dueResolutionAt : null,
    ].filter((due): due is Date => due !== null);

    const nextDueAt =
      [...pending].sort((a, b) => a.getTime() - b.getTime())[0] ?? null;

    return {
      state: slaStateOf(pending, now),
      dueFirstResponseAt,
      dueResolutionAt,
      nextDueAt,
      firstOperatorReplyAt,
    };
  }

  get ticketId(): string {
    return this.props.ticketId;
  }

  get priority(): string {
    return this.props.priority;
  }

  get category(): string | null {
    return this.props.category;
  }

  get status(): string {
    return this.props.status;
  }

  get assigneeId(): string | null {
    return this.props.assigneeId;
  }

  get openedAt(): Date {
    return this.props.openedAt;
  }

  get lastMessageAt(): Date {
    return this.props.lastMessageAt;
  }

  get lastMessageKind(): string | null {
    return this.props.lastMessageKind;
  }

  get dueFirstResponseAt(): Date | null {
    return this.props.dueFirstResponseAt;
  }

  get dueResolutionAt(): Date | null {
    return this.props.dueResolutionAt;
  }

  get firstOperatorReplyAt(): Date | null {
    return this.props.firstOperatorReplyAt;
  }

  get resolvedAt(): Date | null {
    return this.props.resolvedAt;
  }

  get escalatedAt(): Date | null {
    return this.props.escalatedAt;
  }

  get escalatedTo(): string | null {
    return this.props.escalatedTo;
  }

  get escalatedAcknowledgedAt(): Date | null {
    return this.props.escalatedAcknowledgedAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}
