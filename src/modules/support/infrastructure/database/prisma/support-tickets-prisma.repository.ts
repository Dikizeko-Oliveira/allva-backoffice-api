import { Injectable } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  SupportTicket,
  SupportTicketStatus,
  SupportTicketStatusValues,
} from 'src/modules/support/domain/entities';
import {
  ListAdminSupportTicketsFilter,
  ListAdminSupportTicketsResult,
  ListSupportTicketsFilter,
  ListSupportTicketsResult,
  SupportTicketsRepositoryInterface,
  SupportTicketsSummary,
  UNASSIGNED_FILTER,
} from 'src/modules/support/domain/ports';

/**
 * O `select` das leituras — o mesmo nos três caminhos.
 *
 * `attachmentKey`/`attachmentStorageProvider` entram porque `restore` os exige
 * para reconstruir a entidade inteira; a apresentação decide o que publica.
 * `operator.name` vem por `join`: ver o comentário de `operatorName` na
 * entidade para a razão de ele não ser coluna.
 */
const TICKET_SELECT = {
  id: true,
  code: true,
  accountId: true,
  organizationId: true,
  authorName: true,
  authorEmail: true,
  operatorId: true,
  subject: true,
  message: true,
  category: true,
  priority: true,
  status: true,
  attachmentUrl: true,
  attachmentKey: true,
  attachmentStorageProvider: true,
  attachmentFilename: true,
  createdAt: true,
  updatedAt: true,
  lastMessageAt: true,
  resolvedAt: true,
  statusChangedAt: true,
  operator: { select: { name: true } },
} satisfies Prisma.SupportTicketSelect;

type TicketRow = Prisma.SupportTicketGetPayload<{
  select: typeof TICKET_SELECT;
}>;

function toDomain(row: TicketRow): SupportTicket {
  return SupportTicket.restore({
    id: row.id,
    code: row.code,
    accountId: row.accountId,
    organizationId: row.organizationId,
    authorName: row.authorName,
    authorEmail: row.authorEmail,
    operatorId: row.operatorId,
    operatorName: row.operator?.name ?? null,
    subject: row.subject,
    message: row.message,
    category: row.category,
    priority: row.priority,
    status: row.status,
    attachmentUrl: row.attachmentUrl,
    attachmentKey: row.attachmentKey,
    attachmentStorageProvider: row.attachmentStorageProvider,
    attachmentFilename: row.attachmentFilename,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastMessageAt: row.lastMessageAt,
    resolvedAt: row.resolvedAt,
    statusChangedAt: row.statusChangedAt,
  });
}

/** Zera o mapa antes de preenchê-lo: `groupBy` omite o status sem linhas. */
function emptyStatusCounts(): Record<SupportTicketStatus, number> {
  return Object.fromEntries(
    SupportTicketStatusValues.map((status) => [status, 0]),
  ) as Record<SupportTicketStatus, number>;
}

@Injectable()
export class SupportTicketsPrismaRepository implements SupportTicketsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(ticket: SupportTicket): Promise<void> {
    await this.prisma.supportTicket.create({
      data: {
        id: ticket.id,
        code: ticket.code,
        accountId: ticket.accountId,
        organizationId: ticket.organizationId,
        authorName: ticket.authorName,
        authorEmail: ticket.authorEmail,
        operatorId: ticket.operatorId,
        subject: ticket.subject,
        message: ticket.message,
        category: ticket.category,
        priority: ticket.priority,
        status: ticket.status,
        attachmentUrl: ticket.attachmentUrl,
        attachmentKey: ticket.attachmentKey,
        attachmentStorageProvider: ticket.attachmentStorageProvider,
        attachmentFilename: ticket.attachmentFilename,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
        lastMessageAt: ticket.lastMessageAt,
        resolvedAt: ticket.resolvedAt,
        statusChangedAt: ticket.statusChangedAt,
      },
    });
  }

  async findByCode(
    organizationId: string,
    code: string,
  ): Promise<SupportTicket | null> {
    const row = await this.prisma.supportTicket.findFirst({
      where: { organizationId, code },
      select: TICKET_SELECT,
    });

    return row ? toDomain(row) : null;
  }

  async list(
    filter: ListSupportTicketsFilter,
  ): Promise<ListSupportTicketsResult> {
    // Tudo menos o status: é o que as abas contam, e uma aba não pode se
    // contar a si mesma.
    const base = this.whereWithoutStatus(filter);
    const where: Prisma.SupportTicketWhereInput = filter.status
      ? { ...base, status: filter.status }
      : base;

    const [rows, total, grouped] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        select: TICKET_SELECT,
        // Mais recente primeiro — a ordem em que a tela lê, e a mesma do
        // índice `(organization_id, created_at DESC)`.
        orderBy: { createdAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.groupBy({
        by: ['status'],
        where: base,
        _count: true,
        // O Prisma exige `orderBy` no `groupBy`; a ordem em si é irrelevante
        // aqui, porque o resultado vira mapa logo abaixo.
        orderBy: { status: 'asc' },
      }),
    ]);

    // `groupBy` omite o status sem nenhuma linha, e a aba precisa do zero
    // escrito — por isso o mapa nasce zerado, e não do resultado.
    const countsByStatus = emptyStatusCounts();

    for (const group of grouped) {
      countsByStatus[group.status] = group._count;
    }

    return {
      items: rows.map(toDomain),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      countsByStatus,
    };
  }

  async summarize(input: {
    organizationId: string;
    resolvedSince: Date;
  }): Promise<SupportTicketsSummary> {
    const { organizationId, resolvedSince } = input;
    const resolvedInWindow: Prisma.SupportTicketWhereInput = {
      organizationId,
      status: { in: ['RESOLVED', 'CLOSED'] },
      // `resolvedAt`, e não `updatedAt`: desde que existe conversa, um
      // "obrigado" do cliente num chamado resolvido move `updatedAt` e
      // reentraria na janela com um tempo de resolução inflado.
      resolvedAt: { gte: resolvedSince },
    };

    const [total, open, inProgress, resolved] = await this.prisma.$transaction([
      this.prisma.supportTicket.count({ where: { organizationId } }),
      this.prisma.supportTicket.count({
        where: { organizationId, status: 'OPEN' },
      }),
      this.prisma.supportTicket.count({
        where: { organizationId, status: 'IN_PROGRESS' },
      }),
      /**
       * Os pares de datas, não uma média no banco.
       *
       * Postgres calcularia `avg(updated_at - created_at)` num `interval`, e o
       * Prisma não tem esse tipo em `aggregate` — sairia `$queryRaw`, com SQL
       * cru para uma média de algumas dezenas de linhas por organização. A
       * janela já limita o volume; a média sai aqui.
       */
      this.prisma.supportTicket.findMany({
        where: resolvedInWindow,
        select: { createdAt: true, resolvedAt: true },
      }),
    ]);

    const totalMinutes = resolved.reduce(
      (sum, ticket) =>
        sum +
        // `resolvedAt` é não-nulo pelo `where`; o `??` existe para o
        // compilador, não para um caso real.
        ((ticket.resolvedAt ?? ticket.createdAt).getTime() -
          ticket.createdAt.getTime()) /
          60000,
      0,
    );

    return {
      total,
      open,
      inProgress,
      resolvedInWindow: resolved.length,
      averageResolutionMinutes: resolved.length
        ? Math.round(totalMinutes / resolved.length)
        : null,
    };
  }

  // ─── Painel de operador ──────────────────────────────────────────────────

  async listForOperator(
    filter: ListAdminSupportTicketsFilter,
  ): Promise<ListAdminSupportTicketsResult> {
    const base = this.operatorWhereWithoutStatus(filter);
    const where: Prisma.SupportTicketWhereInput = filter.status
      ? { ...base, status: filter.status }
      : base;

    const [rows, total, grouped] = await Promise.all([
      this.prisma.supportTicket.findMany({
        where,
        select: TICKET_SELECT,
        // Quem falou por último primeiro — a ordem de trabalho da fila, e a
        // razão de `last_message_at` existir ao lado de `updated_at`.
        orderBy: { lastMessageAt: 'desc' },
        skip: (filter.page - 1) * filter.pageSize,
        take: filter.pageSize,
      }),
      this.prisma.supportTicket.count({ where }),
      this.prisma.supportTicket.groupBy({
        by: ['status'],
        where: base,
        _count: true,
        orderBy: { status: 'asc' },
      }),
    ]);

    const countsByStatus = emptyStatusCounts();

    for (const group of grouped) {
      countsByStatus[group.status] = group._count;
    }

    return {
      items: rows.map(toDomain),
      total,
      page: filter.page,
      pageSize: filter.pageSize,
      countsByStatus,
    };
  }

  async findById(id: string): Promise<SupportTicket | null> {
    const row = await this.prisma.supportTicket.findUnique({
      where: { id },
      select: TICKET_SELECT,
    });

    return row ? toDomain(row) : null;
  }

  /**
   * Só o que uma escrita de operador move.
   *
   * Assunto, mensagem original, anexo e autor ficam de fora de propósito: são
   * o registro do que o cliente enviou, e nenhuma rota do painel os edita.
   * Um `update` com o objeto inteiro deixaria essa porta aberta.
   */
  async updateTicket(ticket: SupportTicket): Promise<void> {
    await this.prisma.supportTicket.update({
      where: { id: ticket.id },
      data: {
        status: ticket.status,
        operatorId: ticket.operatorId,
        lastMessageAt: ticket.lastMessageAt,
        resolvedAt: ticket.resolvedAt,
        statusChangedAt: ticket.statusChangedAt,
        updatedAt: ticket.updatedAt,
      },
    });
  }

  private operatorWhereWithoutStatus(
    filter: ListAdminSupportTicketsFilter,
  ): Prisma.SupportTicketWhereInput {
    const search = filter.search?.trim();

    return {
      ...(filter.category && { category: filter.category }),
      ...(filter.priority && { priority: filter.priority }),
      ...(filter.organizationId && { organizationId: filter.organizationId }),
      ...(filter.assignee && {
        operatorId:
          filter.assignee === UNASSIGNED_FILTER ? null : filter.assignee,
      }),
      ...(search && {
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { subject: { contains: search, mode: 'insensitive' } },
          // O e-mail e o nome entram aqui e não na busca do cliente: lá todo
          // chamado é da mesma organização, e procurar pelo próprio nome não
          // recorta nada.
          { authorEmail: { contains: search, mode: 'insensitive' } },
          { authorName: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
  }

  private whereWithoutStatus(
    filter: ListSupportTicketsFilter,
  ): Prisma.SupportTicketWhereInput {
    const search = filter.search?.trim();

    return {
      organizationId: filter.organizationId,
      ...(filter.category && { category: filter.category }),
      ...(filter.priority && { priority: filter.priority }),
      ...(search && {
        OR: [
          { code: { contains: search, mode: 'insensitive' } },
          { subject: { contains: search, mode: 'insensitive' } },
        ],
      }),
    };
  }
}
