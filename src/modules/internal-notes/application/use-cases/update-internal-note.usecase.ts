import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { NOTE_SUBJECT_PERMISSION } from 'src/modules/internal-notes/domain/note-subjects';
import { InternalNotesRepositoryInterface } from 'src/modules/internal-notes/domain/ports';
import { InternalNoteOutputDto, UpdateInternalNoteInputDto } from '../dtos';
import { toInternalNoteOutput } from '../internal-note.presenter';
import { assertCanChangeNote, findVisibleNote } from '../note-access';

@Injectable()
export class UpdateInternalNoteUseCase {
  constructor(
    private readonly notesRepository: InternalNotesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    id: string,
    input: UpdateInternalNoteInputDto,
  ): Promise<InternalNoteOutputDto> {
    const note = await findVisibleNote(this.notesRepository, operator, id);
    assertPlatformPermission(
      operator,
      NOTE_SUBJECT_PERMISSION[note.subjectType],
    );
    assertCanChangeNote(operator, note);

    const before = toInternalNoteOutput(note);

    note.edit({ body: input.body, pinned: input.pinned });
    await this.notesRepository.update(note);

    const after = toInternalNoteOutput(note);

    await this.audit.record({
      actor: operator,
      action: 'internal_note.updated',
      subjectType: note.subjectType,
      subjectId: note.subjectId,
      before,
      after,
    });

    return after;
  }
}
