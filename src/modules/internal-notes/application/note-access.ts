import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import type { InternalNote } from '../domain/entities';
import { NOTE_MODERATION_PERMISSION } from '../domain/note-subjects';
import type { InternalNotesRepositoryInterface } from '../domain/ports';

/**
 * A nota que o operador pode ver, ou `404`. Nota invisível para ele responde
 * como inexistente — dizer "existe, mas você não pode ver" já vaza que há algo
 * anotado ali.
 *
 * Não checa a permissão do **assunto**: isso é do use case, que a declara
 * explicitamente.
 */
export async function findVisibleNote(
  repository: InternalNotesRepositoryInterface,
  operator: Operator,
  id: string,
): Promise<InternalNote> {
  const note = await repository.findById(id);

  if (!note || !note.isVisibleTo((permission) => operator.can(permission))) {
    throw new NotFoundException({
      code: 'INTERNAL_NOTE_NOT_FOUND',
      message: 'Internal note not found',
    });
  }

  return note;
}

export function assertCanChangeNote(
  operator: Operator,
  note: InternalNote,
): void {
  if (
    note.canBeChangedBy(operator.id, operator.can(NOTE_MODERATION_PERMISSION))
  ) {
    return;
  }

  throw new ForbiddenException({
    code: 'ACCOUNT_NOT_AUTHORIZED',
    message: 'Only the note author can change this note',
    details: { permission: NOTE_MODERATION_PERMISSION },
  });
}
