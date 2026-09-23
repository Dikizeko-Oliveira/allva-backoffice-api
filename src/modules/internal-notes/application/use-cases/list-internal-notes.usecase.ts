import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { NOTE_SUBJECT_PERMISSION } from 'src/modules/internal-notes/domain/note-subjects';
import { InternalNotesRepositoryInterface } from 'src/modules/internal-notes/domain/ports';
import { InternalNoteOutputDto, ListInternalNotesQueryDto } from '../dtos';
import { toInternalNoteOutput } from '../internal-note.presenter';

@Injectable()
export class ListInternalNotesUseCase {
  constructor(
    private readonly notesRepository: InternalNotesRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: ListInternalNotesQueryDto,
  ): Promise<InternalNoteOutputDto[]> {
    assertPlatformPermission(
      operator,
      NOTE_SUBJECT_PERMISSION[query.subjectType],
    );

    const notes = await this.notesRepository.listBySubject(
      query.subjectType,
      query.subjectId,
    );

    return notes
      .filter((note) =>
        note.isVisibleTo((permission) => operator.can(permission)),
      )
      .map(toInternalNoteOutput);
  }
}
