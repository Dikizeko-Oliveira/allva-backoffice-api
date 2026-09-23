import type { InternalNote } from '../entities';
import type { NoteSubjectType } from '../note-subjects';

export abstract class InternalNotesRepositoryInterface {
  abstract save(note: InternalNote): Promise<void>;
  abstract update(note: InternalNote): Promise<void>;
  /** Só nota não apagada. */
  abstract findById(id: string): Promise<InternalNote | null>;
  /** Só notas não apagadas; fixadas primeiro, depois as mais novas. */
  abstract listBySubject(
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<InternalNote[]>;
}
