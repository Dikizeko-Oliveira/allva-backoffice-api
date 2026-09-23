import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BackofficeAuditLogService } from '../audit/audit-log.service';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';

type SubjectType = 'ORGANIZATION' | 'ACCOUNT' | 'SALES_LEAD' | 'CONTRACT';
type NoteRow = {
  id: string;
  subject_type: SubjectType;
  subject_id: string;
  author_id: string;
  body: string;
  pinned: boolean;
  visibility_permission: string | null;
  created_at: Date;
  edited_at: Date | null;
};

const SUBJECT_PERMISSION: Record<SubjectType, string> = {
  ORGANIZATION: 'orgs:read',
  ACCOUNT: 'users:read',
  SALES_LEAD: 'leads:read',
  CONTRACT: 'billing:read',
};

@Controller('notes')
export class NotesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  @Get()
  async list(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: { subjectType: SubjectType; subjectId: string },
  ) {
    this.assertCanRead(operator, query.subjectType);

    const rows = await this.prisma.$queryRaw<NoteRow[]>`
      SELECT *
      FROM internal_notes
      WHERE subject_type = ${query.subjectType}
        AND subject_id = ${query.subjectId}
        AND deleted_at IS NULL
        AND (
          visibility_permission IS NULL
          OR visibility_permission = ANY(${operator.platformPermissions}::text[])
        )
      ORDER BY pinned DESC, created_at DESC
    `;

    return rows.map(toNote);
  }

  @Post()
  async create(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      subjectType: SubjectType;
      subjectId: string;
      body: string;
      pinned?: boolean;
      visibilityPermission?: string | null;
    },
  ) {
    this.assertCanRead(operator, body.subjectType);
    if (
      body.visibilityPermission &&
      !operator.platformPermissions.includes(body.visibilityPermission)
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message: `Account not authorized: requires platform permission "${body.visibilityPermission}"`,
        details: { permission: body.visibilityPermission },
      });
    }

    const [row] = await this.prisma.$queryRaw<NoteRow[]>`
      INSERT INTO internal_notes (
        subject_type, subject_id, author_id, body, pinned, visibility_permission
      )
      VALUES (
        ${body.subjectType},
        ${body.subjectId},
        ${operator.id},
        ${body.body},
        ${body.pinned ?? false},
        ${body.visibilityPermission ?? null}
      )
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'internal_note.created',
      subjectType: body.subjectType,
      subjectId: body.subjectId,
      after: toNote(row),
    });

    return toNote(row);
  }

  @Patch(':id')
  async update(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body() body: { body?: string; pinned?: boolean },
  ) {
    const before = await this.findVisible(id, operator);
    this.assertCanMutate(operator, before);

    const [row] = await this.prisma.$queryRaw<NoteRow[]>`
      UPDATE internal_notes
      SET
        body = COALESCE(${body.body ?? null}, body),
        pinned = COALESCE(${body.pinned ?? null}, pinned),
        edited_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'internal_note.updated',
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      before: toNote(before),
      after: toNote(row),
    });

    return toNote(row);
  }

  @Delete(':id')
  async remove(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
  ) {
    const before = await this.findVisible(id, operator);
    this.assertCanMutate(operator, before);

    await this.prisma.$executeRaw`
      UPDATE internal_notes
      SET deleted_at = now()
      WHERE id = ${id}
    `;

    await this.audit.record({
      actor: operator,
      action: 'internal_note.deleted',
      subjectType: before.subject_type,
      subjectId: before.subject_id,
      before: toNote(before),
    });

    return { deleted: true };
  }

  private async findVisible(id: string, operator: OperatorContext) {
    const [row] = await this.prisma.$queryRaw<NoteRow[]>`
      SELECT *
      FROM internal_notes
      WHERE id = ${id}
        AND deleted_at IS NULL
        AND (
          visibility_permission IS NULL
          OR visibility_permission = ANY(${operator.platformPermissions}::text[])
        )
      LIMIT 1
    `;

    if (!row) {
      throw new NotFoundException({
        code: 'INTERNAL_NOTE_NOT_FOUND',
        message: 'Internal note not found',
      });
    }

    this.assertCanRead(operator, row.subject_type);
    return row;
  }

  private assertCanRead(operator: OperatorContext, subjectType: SubjectType) {
    const permission = SUBJECT_PERMISSION[subjectType];
    if (operator.platformPermissions.includes(permission)) return;

    throw new ForbiddenException({
      code: 'ACCOUNT_NOT_AUTHORIZED',
      message: `Account not authorized: requires platform permission "${permission}"`,
      details: { permission },
    });
  }

  private assertCanMutate(operator: OperatorContext, note: NoteRow) {
    if (
      note.author_id === operator.id ||
      operator.platformPermissions.includes('settings:manage')
    ) {
      return;
    }

    throw new ForbiddenException({
      code: 'ACCOUNT_NOT_AUTHORIZED',
      message: 'Only the note author can change this note',
      details: { permission: 'settings:manage' },
    });
  }
}

function toNote(row: NoteRow) {
  return {
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    authorId: row.author_id,
    body: row.body,
    pinned: row.pinned,
    visibilityPermission: row.visibility_permission,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
  };
}
