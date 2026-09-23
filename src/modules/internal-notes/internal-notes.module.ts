import { Module } from '@nestjs/common';
import {
  CreateInternalNoteUseCase,
  DeleteInternalNoteUseCase,
  ListInternalNotesUseCase,
  UpdateInternalNoteUseCase,
} from './application/use-cases';
import { InternalNotesRepositoryInterface } from './domain/ports';
import { InternalNotesPrismaRepository } from './infrastructure/database/prisma/internal-notes-prisma.repository';
import { InternalNotesController } from './infrastructure/http/controllers/internal-notes.controller';

@Module({
  controllers: [InternalNotesController],
  providers: [
    ListInternalNotesUseCase,
    CreateInternalNoteUseCase,
    UpdateInternalNoteUseCase,
    DeleteInternalNoteUseCase,
    {
      provide: InternalNotesRepositoryInterface,
      useClass: InternalNotesPrismaRepository,
    },
  ],
})
export class InternalNotesModule {}
