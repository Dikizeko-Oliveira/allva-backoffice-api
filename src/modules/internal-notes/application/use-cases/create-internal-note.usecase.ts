import { Injectable } from '@nestjs/common';
import { BackofficeAuditLogService } from 'src/modules/audit/application/backoffice-audit-log.service';
import {
  assertPlatformPermission,
  platformPermissionDenied,
} from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { InternalNote } from 'src/modules/internal-notes/domain/entities';
import { NOTE_SUBJECT_PERMISSION } from 'src/modules/internal-notes/domain/note-subjects';
import { InternalNotesRepositoryInterface } from 'src/modules/internal-notes/domain/ports';
import { CreateInternalNoteInputDto, InternalNoteOutputDto } from '../dtos';
import { toInternalNoteOutput } from '../internal-note.presenter';

@Injectable()
export class CreateInternalNoteUseCase {
  constructor(
    private readonly notesRepository: InternalNotesRepositoryInterface,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  async execute(
    operator: Operator,
    input: CreateInternalNoteInputDto,
  ): Promise<InternalNoteOutputDto> {
    assertPlatformPermission(
      operator,
      NOTE_SUBJECT_PERMISSION[input.subjectType],
    );

    // Restringir a uma permissão que o próprio autor não tem criaria uma nota
    // que nem ele consegue ler de volta.
    const restriction = input.visibilityPermission;
    if (restriction && !operator.can(restriction)) {
      throw platformPermissionDenied(restriction);
    }

    const note = InternalNote.create({
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      authorId: operator.id,
      body: input.body,
      pinned: input.pinned,
      visibilityPermission: input.visibilityPermission,
    });

    await this.notesRepository.save(note);

    const output = toInternalNoteOutput(note);

    await this.audit.record({
      actor: operator,
      action: 'internal_note.created',
      subjectType: note.subjectType,
      subjectId: note.subjectId,
      after: output,
    });

    return output;
  }
}
