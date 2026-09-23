import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { NOTE_SUBJECT_PERMISSION } from 'src/modules/internal-notes/domain/note-subjects';
import { InternalNotesRepositoryInterface } from 'src/modules/internal-notes/domain/ports';
import { DeleteInternalNoteOutputDto } from '../dtos';
import { toInternalNoteOutput } from '../internal-note.presenter';
import { assertCanChangeNote, findVisibleNote } from '../note-access';

@Injectable()
export class DeleteInternalNoteUseCase {
  constructor(
    private readonly notesRepository: InternalNotesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
  ): Promise<DeleteInternalNoteOutputDto> {
    const note = await findVisibleNote(this.notesRepository, operator, id);
    assertPlatformPermission(
      operator,
      NOTE_SUBJECT_PERMISSION[note.subjectType],
    );
    assertCanChangeNote(operator, note);

    const before = toInternalNoteOutput(note);

    note.delete();
    await this.notesRepository.update(note);

    await this.audit.record({
      actor: operator,
      action: 'internal_note.deleted',
      subjectType: note.subjectType,
      subjectId: note.subjectId,
      before,
    });

    return { deleted: true };
  }
}
