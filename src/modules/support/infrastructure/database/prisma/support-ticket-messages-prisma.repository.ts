import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  SupportTicketMessage,
  SupportTicketMessageKind,
} from 'src/modules/support/domain/entities';
import { SupportTicketMessagesRepositoryInterface } from 'src/modules/support/domain/ports';

@Injectable()
export class SupportTicketMessagesPrismaRepository implements SupportTicketMessagesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async append(message: SupportTicketMessage): Promise<void> {
    await this.prisma.supportTicketMessage.create({
      data: {
        id: message.id,
        ticketId: message.ticketId,
        kind: message.kind,
        authorId: message.authorId,
        authorName: message.authorName,
        body: message.body,
        attachmentUrl: message.attachment?.url ?? null,
        attachmentKey: message.attachment?.key ?? null,
        attachmentStorageProvider: message.attachment?.storageProvider ?? null,
        attachmentFilename: message.attachment?.filename ?? null,
        createdAt: message.createdAt,
      },
    });
  }

  /**
   * `kinds` entra no `where`, e não num `filter` depois da consulta.
   *
   * A diferença importa no dia em que uma conversa tiver cem notas internas:
   * filtrar na aplicação traria as cem do banco para descartá-las — e,
   * sobretudo, um `filter` esquecido devolve a nota, enquanto um `where`
   * esquecido não compila (o parâmetro é obrigatório).
   */
  async listByTicketId(
    ticketId: string,
    kinds: readonly SupportTicketMessageKind[],
  ): Promise<SupportTicketMessage[]> {
    const rows = await this.prisma.supportTicketMessage.findMany({
      where: { ticketId, kind: { in: [...kinds] } },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) =>
      SupportTicketMessage.restore({
        id: row.id,
        ticketId: row.ticketId,
        kind: row.kind,
        authorId: row.authorId,
        authorName: row.authorName,
        body: row.body,
        // Os quatro juntos: `url` presente garante os demais (ver o schema).
        attachment: row.attachmentUrl
          ? {
              url: row.attachmentUrl,
              key: row.attachmentKey ?? '',
              storageProvider: row.attachmentStorageProvider ?? '',
              filename: row.attachmentFilename ?? '',
            }
          : null,
        createdAt: row.createdAt,
      }),
    );
  }
}
