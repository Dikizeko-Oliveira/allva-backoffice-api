import type { InternalNote } from '../domain/entities';
import type { InternalNoteOutputDto } from './dtos';

export function toInternalNoteOutput(
  note: InternalNote,
): InternalNoteOutputDto {
  return {
    id: note.id,
    subjectType: note.subjectType,
    subjectId: note.subjectId,
    authorId: note.authorId,
    body: note.body,
    pinned: note.pinned,
    visibilityPermission: note.visibilityPermission,
    createdAt: note.createdAt,
    editedAt: note.editedAt,
  };
}
