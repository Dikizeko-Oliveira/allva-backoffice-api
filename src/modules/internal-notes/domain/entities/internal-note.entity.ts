import { randomUUID } from 'crypto';
import type { NoteSubjectType } from '../note-subjects';

type InternalNoteProps = {
  id: string;
  subjectType: NoteSubjectType;
  subjectId: string;
  authorId: string;
  body: string;
  pinned: boolean;
  visibilityPermission: string | null;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};

export type CreateInternalNoteProps = {
  subjectType: NoteSubjectType;
  subjectId: string;
  authorId: string;
  body: string;
  pinned?: boolean;
  visibilityPermission?: string | null;
};

/**
 * Anotação de operador sobre algo do produto ("cliente pediu para ligar só à
 * tarde"). Nunca aparece para o cliente.
 *
 * `visibilityPermission` restringe além do assunto: uma nota de cobrança sobre
 * uma organização pode exigir `billing:read` de quem a lê, mesmo que a
 * organização seja visível para o suporte.
 *
 * Apagar é lógico (`deletedAt`): a nota some da tela, mas a auditoria continua
 * apontando para uma linha que existe.
 */
export class InternalNote {
  private constructor(private props: InternalNoteProps) {}

  static create(props: CreateInternalNoteProps): InternalNote {
    return new InternalNote({
      id: randomUUID(),
      subjectType: props.subjectType,
      subjectId: props.subjectId,
      authorId: props.authorId,
      body: props.body,
      pinned: props.pinned ?? false,
      visibilityPermission: props.visibilityPermission ?? null,
      createdAt: new Date(),
      editedAt: null,
      deletedAt: null,
    });
  }

  static restore(props: InternalNoteProps): InternalNote {
    return new InternalNote(props);
  }

  isVisibleTo(can: (permission: string) => boolean): boolean {
    return (
      this.props.deletedAt === null &&
      (this.props.visibilityPermission === null ||
        can(this.props.visibilityPermission))
    );
  }

  /** O autor, ou quem modera. */
  canBeChangedBy(operatorId: string, canModerate: boolean): boolean {
    return this.props.authorId === operatorId || canModerate;
  }

  edit(patch: { body?: string; pinned?: boolean }): void {
    this.props = {
      ...this.props,
      body: patch.body ?? this.props.body,
      pinned: patch.pinned ?? this.props.pinned,
      editedAt: new Date(),
    };
  }

  delete(): void {
    this.props.deletedAt ??= new Date();
  }

  get id(): string {
    return this.props.id;
  }

  get subjectType(): NoteSubjectType {
    return this.props.subjectType;
  }

  get subjectId(): string {
    return this.props.subjectId;
  }

  get authorId(): string {
    return this.props.authorId;
  }

  get body(): string {
    return this.props.body;
  }

  get pinned(): boolean {
    return this.props.pinned;
  }

  get visibilityPermission(): string | null {
    return this.props.visibilityPermission;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get editedAt(): Date | null {
    return this.props.editedAt;
  }

  get deletedAt(): Date | null {
    return this.props.deletedAt;
  }
}
