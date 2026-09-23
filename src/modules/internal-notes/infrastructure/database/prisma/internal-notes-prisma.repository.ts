import { Injectable } from '@nestjs/common';
import type { InternalNote as InternalNoteRecord } from 'generated/prisma/client';
import { InternalNote } from 'src/modules/internal-notes/domain/entities';
import type { NoteSubjectType } from 'src/modules/internal-notes/domain/note-subjects';
import { InternalNotesRepositoryInterface } from 'src/modules/internal-notes/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class InternalNotesPrismaRepository implements InternalNotesRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(note: InternalNote): Promise<void> {
    await this.prisma.internalNote.create({
      data: {
        id: note.id,
        subjectType: note.subjectType,
        subjectId: note.subjectId,
        authorId: note.authorId,
        body: note.body,
        pinned: note.pinned,
        visibilityPermission: note.visibilityPermission,
        createdAt: note.createdAt,
        editedAt: note.editedAt,
        deletedAt: note.deletedAt,
      },
    });
  }

  async update(note: InternalNote): Promise<void> {
    await this.prisma.internalNote.update({
      where: { id: note.id },
      data: {
        body: note.body,
        pinned: note.pinned,
        editedAt: note.editedAt,
        deletedAt: note.deletedAt,
      },
    });
  }

  async findById(id: string): Promise<InternalNote | null> {
    const record = await this.prisma.internalNote.findFirst({
      where: { id, deletedAt: null },
    });
    return record ? toEntity(record) : null;
  }

  async listBySubject(
    subjectType: NoteSubjectType,
    subjectId: string,
  ): Promise<InternalNote[]> {
    const records = await this.prisma.internalNote.findMany({
      where: { subjectType, subjectId, deletedAt: null },
      orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }],
    });
    return records.map(toEntity);
  }
}

function toEntity(record: InternalNoteRecord): InternalNote {
  return InternalNote.restore({
    id: record.id,
    subjectType: record.subjectType as NoteSubjectType,
    subjectId: record.subjectId,
    authorId: record.authorId,
    body: record.body,
    pinned: record.pinned,
    visibilityPermission: record.visibilityPermission,
    createdAt: record.createdAt,
    editedAt: record.editedAt,
    deletedAt: record.deletedAt,
  });
}
