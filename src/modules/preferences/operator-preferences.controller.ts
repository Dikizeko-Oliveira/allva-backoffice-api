import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { BackofficeAuditLogService } from '../audit/audit-log.service';
import { CurrentOperator } from '../auth/current-operator.decorator';
import { OperatorContext } from '../auth/operator-context';

type PreferenceRow = {
  operator_id: string;
  last_workspace: string | null;
  sidebar_collapsed: boolean;
  density: string;
  timezone: string | null;
  updated_at: Date;
};

type SavedViewRow = {
  id: string;
  operator_id: string;
  screen: string;
  name: string;
  filters: unknown;
  columns: unknown;
  sort: unknown;
  is_default: boolean;
  shared: boolean;
  created_at: Date;
  updated_at: Date;
};

const SCREEN_PERMISSION: Record<string, string> = {
  dashboard: 'dashboard:read',
  organizations: 'orgs:read',
  users: 'users:read',
  leads: 'leads:read',
  support: 'support:read',
  contacts: 'contacts:read',
  subscriptions: 'subscriptions:read',
  payments: 'billing:read',
  integrations: 'integrations:read',
  operations: 'operations:read',
  audit: 'audit:read',
  operators: 'users:read',
  settings: 'settings:read',
};

@Controller()
export class OperatorPreferencesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: BackofficeAuditLogService,
  ) {}

  @Get('me/preferences')
  async getPreferences(@CurrentOperator() operator: OperatorContext) {
    const [row] = await this.prisma.$queryRaw<PreferenceRow[]>`
      SELECT * FROM operator_preferences WHERE operator_id = ${operator.id}
    `;

    return row ? toPreference(row) : defaultPreference(operator.id);
  }

  @Put('me/preferences')
  async putPreferences(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      lastWorkspace?: string | null;
      sidebarCollapsed?: boolean;
      density?: string;
      timezone?: string | null;
    },
  ) {
    const [row] = await this.prisma.$queryRaw<PreferenceRow[]>`
      INSERT INTO operator_preferences (
        operator_id, last_workspace, sidebar_collapsed, density, timezone
      )
      VALUES (
        ${operator.id},
        ${body.lastWorkspace ?? null},
        ${body.sidebarCollapsed ?? false},
        ${body.density ?? 'comfortable'},
        ${body.timezone ?? null}
      )
      ON CONFLICT (operator_id) DO UPDATE
      SET last_workspace = EXCLUDED.last_workspace,
          sidebar_collapsed = EXCLUDED.sidebar_collapsed,
          density = EXCLUDED.density,
          timezone = EXCLUDED.timezone,
          updated_at = now()
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'operator_preferences.updated',
      subjectType: 'OPERATOR',
      subjectId: operator.id,
      after: toPreference(row),
    });

    return toPreference(row);
  }

  @Get('views')
  async listViews(
    @CurrentOperator() operator: OperatorContext,
    @Query() query: { screen?: string },
  ) {
    if (query.screen) assertScreenPermission(operator, query.screen);

    const rows = await this.prisma.$queryRawUnsafe<SavedViewRow[]>(
      `
        SELECT *
        FROM saved_views
        WHERE ($1::text IS NULL OR screen = $1)
          AND (operator_id = $2 OR shared = true)
        ORDER BY is_default DESC, name ASC
      `,
      query.screen ?? null,
      operator.id,
    );

    return rows
      .filter((row) => canReadScreen(operator, row.screen))
      .map(toSavedView);
  }

  @Post('views')
  async createView(
    @CurrentOperator() operator: OperatorContext,
    @Body()
    body: {
      screen: string;
      name: string;
      filters?: unknown;
      columns?: unknown;
      sort?: unknown;
      isDefault?: boolean;
      shared?: boolean;
    },
  ) {
    assertScreenPermission(operator, body.screen);

    const [row] = await this.prisma.$queryRaw<SavedViewRow[]>`
      INSERT INTO saved_views (
        operator_id, screen, name, filters, columns, sort, is_default, shared
      )
      VALUES (
        ${operator.id},
        ${body.screen},
        ${body.name},
        ${JSON.stringify(body.filters ?? {})}::jsonb,
        ${JSON.stringify(body.columns ?? [])}::jsonb,
        ${JSON.stringify(body.sort ?? null)}::jsonb,
        ${body.isDefault ?? false},
        ${body.shared ?? false}
      )
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'saved_view.created',
      subjectType: 'SAVED_VIEW',
      subjectId: row.id,
      after: toSavedView(row),
    });

    return toSavedView(row);
  }

  @Patch('views/:id')
  async updateView(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
    @Body()
    body: Partial<{
      name: string;
      filters: unknown;
      columns: unknown;
      sort: unknown;
      isDefault: boolean;
      shared: boolean;
    }>,
  ) {
    const before = await this.findOwnedView(id, operator);
    const [row] = await this.prisma.$queryRaw<SavedViewRow[]>`
      UPDATE saved_views
      SET
        name = COALESCE(${body.name ?? null}, name),
        filters = CASE WHEN ${Object.hasOwn(body, 'filters')} THEN ${JSON.stringify(body.filters ?? {})}::jsonb ELSE filters END,
        columns = CASE WHEN ${Object.hasOwn(body, 'columns')} THEN ${JSON.stringify(body.columns ?? [])}::jsonb ELSE columns END,
        sort = CASE WHEN ${Object.hasOwn(body, 'sort')} THEN ${JSON.stringify(body.sort ?? null)}::jsonb ELSE sort END,
        is_default = COALESCE(${body.isDefault ?? null}, is_default),
        shared = COALESCE(${body.shared ?? null}, shared),
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;

    await this.audit.record({
      actor: operator,
      action: 'saved_view.updated',
      subjectType: 'SAVED_VIEW',
      subjectId: id,
      before: toSavedView(before),
      after: toSavedView(row),
    });

    return toSavedView(row);
  }

  @Delete('views/:id')
  async deleteView(
    @CurrentOperator() operator: OperatorContext,
    @Param('id') id: string,
  ) {
    const before = await this.findOwnedView(id, operator);
    await this.prisma.$executeRaw`DELETE FROM saved_views WHERE id = ${id}`;
    await this.audit.record({
      actor: operator,
      action: 'saved_view.deleted',
      subjectType: 'SAVED_VIEW',
      subjectId: id,
      before: toSavedView(before),
    });
    return { deleted: true };
  }

  private async findOwnedView(id: string, operator: OperatorContext) {
    const [row] = await this.prisma.$queryRaw<SavedViewRow[]>`
      SELECT * FROM saved_views WHERE id = ${id} AND operator_id = ${operator.id}
    `;
    if (!row) {
      throw new NotFoundException({
        code: 'SAVED_VIEW_NOT_FOUND',
        message: 'Saved view not found',
      });
    }
    assertScreenPermission(operator, row.screen);
    return row;
  }
}

function canReadScreen(operator: OperatorContext, screen: string) {
  const permission = SCREEN_PERMISSION[screen];
  return Boolean(
    permission && operator.platformPermissions.includes(permission),
  );
}

function assertScreenPermission(operator: OperatorContext, screen: string) {
  if (canReadScreen(operator, screen)) return;
  const permission = SCREEN_PERMISSION[screen] ?? 'dashboard:read';
  throw new NotFoundException({
    code: 'SAVED_VIEW_SCREEN_NOT_AVAILABLE',
    message: 'Saved view screen is not available',
    details: { permission },
  });
}

function defaultPreference(operatorId: string) {
  return {
    operatorId,
    lastWorkspace: null,
    sidebarCollapsed: false,
    density: 'comfortable',
    timezone: null,
  };
}

function toPreference(row: PreferenceRow) {
  return {
    operatorId: row.operator_id,
    lastWorkspace: row.last_workspace,
    sidebarCollapsed: row.sidebar_collapsed,
    density: row.density,
    timezone: row.timezone,
    updatedAt: row.updated_at.toISOString(),
  };
}

function toSavedView(row: SavedViewRow) {
  return {
    id: row.id,
    operatorId: row.operator_id,
    screen: row.screen,
    name: row.name,
    filters: row.filters,
    columns: row.columns,
    sort: row.sort,
    isDefault: row.is_default,
    shared: row.shared,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
