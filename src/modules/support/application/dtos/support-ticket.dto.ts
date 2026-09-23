import { ApiProperty } from '@nestjs/swagger';
import {
  SupportTicketCategory,
  SupportTicketCategoryValues,
  SupportTicketMessageKind,
  SupportTicketMessageKindValues,
  SupportTicketPriority,
  SupportTicketPriorityValues,
  SupportTicketStatus,
  SupportTicketStatusValues,
} from 'src/modules/support/domain/entities';

export class SupportTicketOutputDto {
  @ApiProperty({ example: 'SUP-20260828-7K4N' })
  code: string;

  @ApiProperty({ example: 'Não consigo conectar minha conta do Meta' })
  subject: string;

  @ApiProperty({ enum: SupportTicketCategoryValues })
  category: SupportTicketCategory;

  @ApiProperty({ enum: SupportTicketPriorityValues })
  priority: SupportTicketPriority;

  @ApiProperty({ enum: SupportTicketStatusValues })
  status: SupportTicketStatus;

  @ApiProperty({ example: 'Kevin de Oliveira' })
  requesterName: string;

  @ApiProperty({
    nullable: true,
    description:
      'Nome de quem atende. `null` enquanto ninguém foi atribuído — hoje, sempre.',
  })
  assigneeName: string | null;

  @ApiProperty({ example: false })
  hasAttachment: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty({
    description:
      'Quando alguém falou pela última vez na conversa. É o que a lista mostra como "atualizado" — trocar o status não é falar.',
  })
  lastMessageAt: Date;

  @ApiProperty({ nullable: true })
  resolvedAt: Date | null;
}

/**
 * Um evento do histórico do chamado.
 *
 * **Derivado, não registrado.** Não existe tabela de eventos, e não existe
 * porque não existe produtor: nada além da criação escreve num chamado hoje —
 * não há painel de operador, não há resposta, não há mudança de status. Um
 * log de eventos agora seria uma tabela com exatamente uma linha por chamado,
 * duplicando `created_at`.
 *
 * O que a tela mostra são os fatos duráveis que o próprio chamado carrega:
 * quando foi aberto e por quem, e — quando o status já não é o inicial —
 * quando ele mudou. Nasce honesto e pequeno; vira leitura de uma tabela real
 * no dia em que algo produzir eventos de verdade.
 */
export class SupportTicketEventDto {
  @ApiProperty({ enum: ['CREATED', 'STATUS_CHANGED'] })
  type: 'CREATED' | 'STATUS_CHANGED';

  @ApiProperty()
  at: Date;

  @ApiProperty({ nullable: true })
  actorName: string | null;

  @ApiProperty({
    enum: SupportTicketStatusValues,
    nullable: true,
    description: 'O status alcançado. `null` em `CREATED`.',
  })
  status: SupportTicketStatus | null;
}

export class SupportTicketAttachmentDto {
  @ApiProperty({ example: 'erro-relatorio.png' })
  filename: string;

  @ApiProperty({
    nullable: true,
    description:
      'URL de leitura **assinada**, válida por uma hora — o bucket é privado. `null` quando a assinatura falhou: a tela mostra o nome do arquivo sem link, em vez de um link que responde 403.',
  })
  url: string | null;
}

export class SupportTicketMessageDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: SupportTicketMessageKindValues,
    description:
      '`INTERNAL_NOTE` **nunca** aparece nas rotas de cliente — só na do painel de operador.',
  })
  kind: SupportTicketMessageKind;

  @ApiProperty()
  authorName: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ type: SupportTicketAttachmentDto, nullable: true })
  attachment: SupportTicketAttachmentDto | null;

  @ApiProperty()
  createdAt: Date;
}

export class SupportTicketDetailOutputDto extends SupportTicketOutputDto {
  @ApiProperty({ example: 'kevin@example.com' })
  requesterEmail: string;

  @ApiProperty({
    description:
      'Texto puro, já sanitizado na entrada por `@SanitizeMultiline`. A tela é quem decide como quebrar linha — o backend nunca devolve HTML.',
  })
  message: string;

  @ApiProperty({ type: SupportTicketAttachmentDto, nullable: true })
  attachment: SupportTicketAttachmentDto | null;

  @ApiProperty({
    type: [SupportTicketMessageDto],
    description:
      'A conversa — mensagens do cliente e respostas do suporte, em ordem. Notas internas do time nunca entram aqui.',
  })
  messages: SupportTicketMessageDto[];

  @ApiProperty({
    type: [SupportTicketEventDto],
    description:
      'O histórico de estado, ao lado da conversa. Responde "quando mudou de status", que nenhuma mensagem responde.',
  })
  timeline: SupportTicketEventDto[];

  @ApiProperty({
    description:
      'Se o cliente pode responder. Falso em chamado encerrado — ver o use case de resposta.',
  })
  canReply: boolean;
}

export class SupportTicketStatusCountsDto {
  @ApiProperty()
  OPEN: number;

  @ApiProperty()
  IN_PROGRESS: number;

  @ApiProperty()
  RESOLVED: number;

  @ApiProperty()
  CLOSED: number;
}

export class ListSupportTicketsOutputDto {
  @ApiProperty({ type: [SupportTicketOutputDto] })
  items: SupportTicketOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;

  @ApiProperty({
    type: SupportTicketStatusCountsDto,
    description:
      'Contagem por status sob os demais filtros, ignorando `status`. É o número escrito em cada aba da tela.',
  })
  countsByStatus: SupportTicketStatusCountsDto;
}

export class SupportTicketsSummaryOutputDto {
  @ApiProperty()
  total: number;

  @ApiProperty()
  open: number;

  @ApiProperty()
  inProgress: number;

  @ApiProperty({ description: 'Resolvidos ou encerrados na janela.' })
  resolvedInWindow: number;

  @ApiProperty({
    nullable: true,
    description:
      'Média de tempo até a resolução, em minutos. `null` quando nada foi resolvido na janela.',
  })
  averageResolutionMinutes: number | null;

  @ApiProperty({
    example: 30,
    description: 'Tamanho da janela, em dias — para a tela rotular o cartão.',
  })
  windowDays: number;
}
