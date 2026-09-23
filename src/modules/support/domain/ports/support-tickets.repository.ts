import {
  SupportTicket,
  SupportTicketCategory,
  SupportTicketMessage,
  SupportTicketPriority,
  SupportTicketStatus,
} from '../entities';

export type ListSupportTicketsFilter = {
  /**
   * Sempre presente, e sempre vindo do contexto autenticado. É o escopo do
   * chamado: um chamado pertence à organização que o abriu, e nenhuma consulta
   * desta porta existe sem ele — por isso é campo obrigatório do filtro, e não
   * mais um opcional que alguém esquece de passar.
   */
  organizationId: string;
  status?: SupportTicketStatus;
  category?: SupportTicketCategory;
  priority?: SupportTicketPriority;
  /** Código ou assunto — o campo de busca da tela de chamados. */
  search?: string;
  page: number;
  pageSize: number;
};

export type ListSupportTicketsResult = {
  items: SupportTicket[];
  total: number;
  page: number;
  pageSize: number;
  /**
   * Quantos chamados há em cada status **sob os demais filtros**, ignorando
   * `status`.
   *
   * Vem junto da listagem, e não de uma segunda chamada, porque é exatamente o
   * que as abas da tela mostram: trocar de aba não pode mudar o número escrito
   * nas outras abas. Contado no banco, numa agregação só — contar em cima de
   * `items` daria o total da página, não do filtro.
   */
  countsByStatus: Record<SupportTicketStatus, number>;
};

/**
 * O recorte da fila do painel de operador — **cross-org**, e é essa a
 * diferença que impede de reusar `ListSupportTicketsFilter`.
 *
 * Lá `organizationId` é obrigatório e vem do contexto autenticado; aqui é um
 * filtro opcional, porque o operador atende a base inteira. Espelhar os dois
 * num tipo só com o campo opcional apagaria justamente a garantia que o lado
 * do cliente precisa ter — a de que nenhuma consulta sai sem escopo.
 */
export type ListAdminSupportTicketsFilter = {
  /** Código, assunto, e-mail ou nome do solicitante. */
  search?: string;
  status?: SupportTicketStatus;
  priority?: SupportTicketPriority;
  category?: SupportTicketCategory;
  organizationId?: string;
  /**
   * Id do operador, ou `'none'` para os que ninguém pegou.
   *
   * O literal vem do painel (`UNASSIGNED` em `domain/ticket.ts`) e para aqui:
   * o repositório o traduz para `operatorId: null`. Um campo booleano
   * separado (`unassigned`) permitiria pedir as duas coisas ao mesmo tempo, o
   * que não quer dizer nada.
   */
  assignee?: string;
  page: number;
  pageSize: number;
};

export const UNASSIGNED_FILTER = 'none';

export type ListAdminSupportTicketsResult = {
  items: SupportTicket[];
  total: number;
  page: number;
  pageSize: number;
  countsByStatus: Record<SupportTicketStatus, number>;
};

export type SupportTicketsSummary = {
  total: number;
  open: number;
  inProgress: number;
  /** Resolvidos **ou** encerrados dentro da janela. */
  resolvedInWindow: number;
  /**
   * Média de `updatedAt - createdAt` dos chamados resolvidos na janela, em
   * minutos. `null` quando nenhum foi.
   *
   * `updatedAt` é o carimbo de resolução por aproximação, e a aproximação é
   * exata hoje: nada além da mudança de status escreve num chamado depois de
   * criado. Uma coluna `resolved_at` dedicada só faz sentido quando existir
   * painel de operador escrevendo outras coisas no chamado — até lá seria uma
   * coluna que ninguém preenche, e o número sairia sempre nulo.
   */
  averageResolutionMinutes: number | null;
};

/**
 * Persistência e leitura de chamados.
 *
 * Nasceu só com `save` — o escopo do Drawer de suporte. A Central de suporte
 * (`/account/support/*`, exclusiva do Enterprise) é quem trouxe as leituras:
 * listagem paginada, chamado por código e os indicadores do topo. Atualização
 * de status e atribuição de operador continuam de fora, porque continuam sem
 * tela que as produza — o painel de suporte ainda não existe.
 */
export abstract class SupportTicketsRepositoryInterface {
  abstract save(ticket: SupportTicket): Promise<void>;

  /**
   * O código, e não o id: é o que o usuário lê, copia e dita ao telefone
   * (`SUP-20260828-7K4N`), e é o que viaja na URL da tela. `organizationId`
   * entra no `where`, não numa checagem depois — um código de outra
   * organização precisa ser indistinguível de um código que não existe.
   */
  abstract findByCode(
    organizationId: string,
    code: string,
  ): Promise<SupportTicket | null>;

  abstract list(
    filter: ListSupportTicketsFilter,
  ): Promise<ListSupportTicketsResult>;

  abstract summarize(input: {
    organizationId: string;
    /** Início da janela dos "resolvidos recentemente". */
    resolvedSince: Date;
  }): Promise<SupportTicketsSummary>;

  // ─── Painel de operador ──────────────────────────────────────────────────
  //
  // Sem escopo de organização, e é por isso que estão separados dos de cima
  // em vez de ganharem um parâmetro opcional: quem chama estes já passou por
  // `PlatformRoleService.assertPermission`, e a assinatura diferente é o que
  // torna impossível uma rota de cliente cair neles por descuido.

  abstract listForOperator(
    filter: ListAdminSupportTicketsFilter,
  ): Promise<ListAdminSupportTicketsResult>;

  /** Por id, e não por código: é o que a URL do painel carrega. */
  abstract findById(id: string): Promise<SupportTicket | null>;

  /** Persiste status, responsável e os carimbos que eles movem. */
  abstract updateTicket(ticket: SupportTicket): Promise<void>;
}

/**
 * A conversa. Separada de `SupportTicketsRepositoryInterface` porque é outra
 * tabela com outro ciclo de vida — e porque a nota interna nunca deve sair
 * pela mesma porta que a listagem do cliente.
 */
export abstract class SupportTicketMessagesRepositoryInterface {
  abstract append(message: SupportTicketMessage): Promise<void>;

  /**
   * @param kinds quais tipos incluir. **Obrigatório, e sem default**: um
   *   default que incluísse tudo faria a rota de cliente vazar nota interna
   *   por omissão, que é o modo mais provável de isso acontecer.
   */
  abstract listByTicketId(
    ticketId: string,
    kinds: readonly SupportTicketMessage['kind'][],
  ): Promise<SupportTicketMessage[]>;
}
