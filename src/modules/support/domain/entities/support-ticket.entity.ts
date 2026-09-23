import { randomUUID, randomInt } from 'crypto';

export const SupportTicketCategoryValues = [
  'GENERAL',
  'BILLING',
  'TECHNICAL',
  'ACCOUNT',
] as const;

export type SupportTicketCategory =
  (typeof SupportTicketCategoryValues)[number];

export const SupportTicketPriorityValues = [
  'LOW',
  'MEDIUM',
  'HIGH',
  'CRITICAL',
] as const;

export type SupportTicketPriority =
  (typeof SupportTicketPriorityValues)[number];

/**
 * A ordem das prioridades, para comparar duas sem espalhar `switch` por aí.
 *
 * Existe porque a prioridade passou a ter **duas fontes**: o que o solicitante
 * declara no formulário e o teto que o plano concede. Comparar exige ordem, e
 * a ordem estava implícita na posição dentro de `SupportTicketPriorityValues`
 * — implícita o bastante para uma reordenação cosmética virar uma mudança de
 * regra silenciosa.
 */
const PRIORITY_RANK: Record<SupportTicketPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

/**
 * A prioridade pedida, limitada ao teto que o plano concede.
 *
 * Quem não tem `support-priority` pode declarar urgência — e a declaração
 * continua valendo para baixo (LOW é sempre aceito). O que o teto impede é
 * furar a fila: sem a linha no plano, CRITICAL vira MEDIUM. A alternativa,
 * ignorar o campo inteiro para quem não tem a linha, apagaria também a
 * informação legítima de que o chamado é de baixa urgência.
 */
export function clampPriority(
  requested: SupportTicketPriority,
  ceiling: SupportTicketPriority,
): SupportTicketPriority {
  return PRIORITY_RANK[requested] > PRIORITY_RANK[ceiling]
    ? ceiling
    : requested;
}

export const SupportTicketStatusValues = [
  'OPEN',
  'IN_PROGRESS',
  'RESOLVED',
  'CLOSED',
] as const;

export type SupportTicketStatus = (typeof SupportTicketStatusValues)[number];

/** Caracteres sem `0/O` e `1/I` — o código é lido em voz alta ao telefone. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** `SUP-20260828-7K4N` — data de criação e sufixo aleatório de 4 caracteres. */
function generateTicketCode(now: Date): string {
  const datePart = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = Array.from({ length: 4 }, () =>
    CODE_ALPHABET.charAt(randomInt(0, CODE_ALPHABET.length)),
  ).join('');

  return `SUP-${datePart}-${suffix}`;
}

/**
 * A prioridade efetiva: o que o solicitante declarou, limitado ao que o plano
 * concede.
 *
 * Mora no domínio, e não no use case que a chama, porque é a mesma regra que
 * `clampPriority` implementa metade — separá-las em camadas diferentes faria
 * "quanto o plano concede" viver longe de "o que fazer quando pedem mais".
 *
 * Sem declaração vale a regra original: `support-priority` decide entre HIGH
 * e MEDIUM, e o chamado nunca nasce LOW por omissão. O Drawer não expõe o
 * campo — quem escreve ali está pedindo ajuda, não triando uma fila.
 */
export function resolveTicketPriority(
  requested: SupportTicketPriority | undefined,
  hasPriorityEntitlement: boolean,
): SupportTicketPriority {
  if (!requested) return hasPriorityEntitlement ? 'HIGH' : 'MEDIUM';

  return clampPriority(
    requested,
    hasPriorityEntitlement ? 'CRITICAL' : 'MEDIUM',
  );
}

type CreateSupportTicketProps = {
  accountId: string;
  organizationId: string;
  authorName: string;
  authorEmail: string;
  subject: string;
  message: string;
  /**
   * Resolvida uma única vez, na criação, a partir do entitlement
   * `support-priority` — não recalculada depois. Ver comentário do modelo no
   * schema.
   */
  priority: SupportTicketPriority;
  category?: SupportTicketCategory;
  /**
   * Os quatro campos do anexo nascem e morrem juntos — ou o print foi subido
   * e todos vêm preenchidos, ou nenhum foi. `SendSupportMessageUseCase` é
   * quem garante isso antes de chamar `create`.
   */
  attachment?: SupportTicketAttachment | null;
};

export type SupportTicketAttachment = {
  url: string;
  key: string;
  storageProvider: string;
  filename: string;
};

type RestoreSupportTicketProps = {
  id: string;
  code: string;
  accountId: string;
  organizationId: string;
  authorName: string;
  authorEmail: string;
  operatorId: string | null;
  /**
   * Nome de exibição do operador, vindo do `join` com `accounts` — **não é
   * coluna de `support_tickets`**, ao contrário de `authorName`.
   *
   * A assimetria é deliberada. `authorName` é carimbo: o nome que o
   * solicitante tinha quando abriu o chamado, e que precisa sobreviver a uma
   * troca de nome na conta. O operador é o contrário — a tela quer saber com
   * quem o chamado está **agora**, então o valor é lido junto, na hora, e
   * `null` quando ninguém foi atribuído (o estado de todos os chamados hoje:
   * não existe atribuição automática nem painel que a faça).
   */
  operatorName?: string | null;
  subject: string;
  message: string;
  category: SupportTicketCategory;
  priority: SupportTicketPriority;
  status: SupportTicketStatus;
  attachmentUrl: string | null;
  attachmentKey: string | null;
  attachmentStorageProvider: string | null;
  attachmentFilename: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
  resolvedAt: Date | null;
  statusChangedAt: Date | null;
};

export class SupportTicket {
  private _id: string;
  private _code: string;
  private _accountId: string;
  private _organizationId: string;
  private _authorName: string;
  private _authorEmail: string;
  private _operatorId: string | null;
  private _operatorName: string | null;
  private _subject: string;
  private _message: string;
  private _category: SupportTicketCategory;
  private _priority: SupportTicketPriority;
  private _status: SupportTicketStatus;
  private _attachmentUrl: string | null;
  private _attachmentKey: string | null;
  private _attachmentStorageProvider: string | null;
  private _attachmentFilename: string | null;
  private _createdAt: Date;
  private _updatedAt: Date;
  private _lastMessageAt: Date;
  private _resolvedAt: Date | null;
  private _statusChangedAt: Date | null;

  private constructor(props: RestoreSupportTicketProps) {
    this._id = props.id;
    this._code = props.code;
    this._accountId = props.accountId;
    this._organizationId = props.organizationId;
    this._authorName = props.authorName;
    this._authorEmail = props.authorEmail;
    this._operatorId = props.operatorId;
    this._operatorName = props.operatorName ?? null;
    this._subject = props.subject;
    this._message = props.message;
    this._category = props.category;
    this._priority = props.priority;
    this._status = props.status;
    this._attachmentUrl = props.attachmentUrl;
    this._attachmentKey = props.attachmentKey;
    this._attachmentStorageProvider = props.attachmentStorageProvider;
    this._attachmentFilename = props.attachmentFilename;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._lastMessageAt = props.lastMessageAt;
    this._resolvedAt = props.resolvedAt;
    this._statusChangedAt = props.statusChangedAt;
  }

  static create(props: CreateSupportTicketProps): SupportTicket {
    const now = new Date();

    return new SupportTicket({
      id: randomUUID(),
      code: generateTicketCode(now),
      accountId: props.accountId,
      organizationId: props.organizationId,
      authorName: props.authorName,
      authorEmail: props.authorEmail,
      // Nenhum operador é atribuído automaticamente ainda.
      operatorId: null,
      subject: props.subject,
      message: props.message,
      category: props.category ?? 'GENERAL',
      priority: props.priority,
      status: 'OPEN',
      attachmentUrl: props.attachment?.url ?? null,
      attachmentKey: props.attachment?.key ?? null,
      attachmentStorageProvider: props.attachment?.storageProvider ?? null,
      attachmentFilename: props.attachment?.filename ?? null,
      createdAt: now,
      updatedAt: now,
      // A conversa começa com a mensagem que abriu o chamado, então o
      // "falou por último" nasce igual à criação.
      lastMessageAt: now,
      resolvedAt: null,
      statusChangedAt: null,
    });
  }

  static restore(props: RestoreSupportTicketProps): SupportTicket {
    return new SupportTicket(props);
  }

  get id() {
    return this._id;
  }

  get code() {
    return this._code;
  }

  get accountId() {
    return this._accountId;
  }

  get organizationId() {
    return this._organizationId;
  }

  get authorName() {
    return this._authorName;
  }

  get authorEmail() {
    return this._authorEmail;
  }

  get operatorId() {
    return this._operatorId;
  }

  get operatorName() {
    return this._operatorName;
  }

  get subject() {
    return this._subject;
  }

  get message() {
    return this._message;
  }

  get category() {
    return this._category;
  }

  get priority() {
    return this._priority;
  }

  get status() {
    return this._status;
  }

  get attachmentUrl() {
    return this._attachmentUrl;
  }

  get attachmentKey() {
    return this._attachmentKey;
  }

  get attachmentStorageProvider() {
    return this._attachmentStorageProvider;
  }

  get attachmentFilename() {
    return this._attachmentFilename;
  }

  get hasAttachment(): boolean {
    return this._attachmentUrl !== null;
  }

  get createdAt() {
    return this._createdAt;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  get lastMessageAt() {
    return this._lastMessageAt;
  }

  get resolvedAt() {
    return this._resolvedAt;
  }

  get statusChangedAt() {
    return this._statusChangedAt;
  }

  /** Fora das mãos do operador — não ocupa mais a fila de trabalho. */
  get isSettled(): boolean {
    return this._status === 'RESOLVED' || this._status === 'CLOSED';
  }

  /**
   * O operador mudou o status.
   *
   * `resolvedAt` acompanha, nos dois sentidos: entra em RESOLVED/CLOSED e é
   * carimbado; sai, e é limpo. Um chamado reaberto sem essa limpeza
   * continuaria contando como resolvido na média de tempo de resolução — e
   * contaria com o tempo da resolução que não valeu.
   *
   * Idempotente: repetir o status atual não mexe em carimbo nenhum. Sem isso,
   * um duplo clique no `<select>` do painel reescreveria `statusChangedAt` e
   * moveria a resolução para agora.
   */
  changeStatus(status: SupportTicketStatus, now: Date = new Date()): void {
    if (status === this._status) return;

    const wasSettled = this.isSettled;

    this._status = status;
    this._statusChangedAt = now;
    this._updatedAt = now;

    if (this.isSettled) {
      // Só carimba na **entrada**: reabrir e resolver de novo carimba de novo,
      // e é o certo — a resolução que vale é a última.
      if (!wasSettled) this._resolvedAt = now;
    } else {
      this._resolvedAt = null;
    }
  }

  /** `null` desatribui — a fila volta a mostrar o chamado como sem responsável. */
  assignTo(operatorId: string | null, now: Date = new Date()): void {
    if (operatorId === this._operatorId) return;

    this._operatorId = operatorId;
    // O nome de exibição vem de `join` e não é conhecido aqui; quem relê o
    // chamado depois da escrita o traz. Zerá-lo evita devolver o nome do
    // operador anterior ao lado do id do novo.
    this._operatorName = null;
    this._updatedAt = now;
  }

  /**
   * Alguém falou.
   *
   * A mensagem em si é gravada pelo repositório; o que o chamado guarda é o
   * efeito dela sobre a própria linha. `updatedAt` também anda: a linha mudou.
   */
  registerMessage(now: Date = new Date()): void {
    this._lastMessageAt = now;
    this._updatedAt = now;
  }

  toJSON() {
    return {
      id: this._id,
      code: this._code,
      accountId: this._accountId,
      organizationId: this._organizationId,
      authorName: this._authorName,
      authorEmail: this._authorEmail,
      operatorId: this._operatorId,
      operatorName: this._operatorName,
      subject: this._subject,
      message: this._message,
      category: this._category,
      priority: this._priority,
      status: this._status,
      attachmentUrl: this._attachmentUrl,
      attachmentFilename: this._attachmentFilename,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
      lastMessageAt: this._lastMessageAt,
      resolvedAt: this._resolvedAt,
      statusChangedAt: this._statusChangedAt,
    };
  }
}
