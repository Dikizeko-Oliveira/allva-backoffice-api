import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PLATFORM_PERMISSIONS } from 'src/modules/auth/domain/platform-permissions';
import {
  NOTE_SUBJECT_TYPES,
  type NoteSubjectType,
} from 'src/modules/internal-notes/domain/note-subjects';

const MAX_NOTE_LENGTH = 10_000;

export class ListInternalNotesQueryDto {
  @ApiProperty({ enum: NOTE_SUBJECT_TYPES })
  @IsIn(NOTE_SUBJECT_TYPES)
  subjectType: NoteSubjectType;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  subjectId: string;
}

export class CreateInternalNoteInputDto extends ListInternalNotesQueryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NOTE_LENGTH)
  body: string;

  @ApiProperty({ required: false, default: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @ApiProperty({
    required: false,
    nullable: true,
    enum: PLATFORM_PERMISSIONS,
    description:
      'Restringe a nota a quem tem esta permissão, além da do assunto. Só pode ser uma permissão que o autor tem.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsIn(PLATFORM_PERMISSIONS)
  visibilityPermission?: string | null;
}

export class UpdateInternalNoteInputDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_NOTE_LENGTH)
  body?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class InternalNoteOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: NOTE_SUBJECT_TYPES })
  subjectType: NoteSubjectType;

  @ApiProperty()
  subjectId: string;

  @ApiProperty()
  authorId: string;

  @ApiProperty()
  body: string;

  @ApiProperty()
  pinned: boolean;

  @ApiProperty({ nullable: true })
  visibilityPermission: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty({ nullable: true })
  editedAt: Date | null;
}

export class DeleteInternalNoteOutputDto {
  @ApiProperty({ example: true })
  deleted: true;
}
