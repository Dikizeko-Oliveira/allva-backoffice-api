import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDate,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  type PlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';
import {
  ORGANIZATION_STATUSES,
  type OrganizationStatus,
} from 'src/modules/platform-admin/domain/organization-status';

const PLAN_TYPES = ['FREE', 'STARTER', 'PRO', 'ENTERPRISE'] as const;

/** `?overdue=true` chega como string; só `"true"` liga. */
const toBoolean = ({ value }: { value: unknown }) =>
  value === true || value === 'true';

/**
 * Página e tamanho, iguais aos das outras listas administrativas
 * (`ListContractsQueryDto`): 20 por padrão. O teto de 100 existe porque a
 * exportação do backoffice varre página a página — uma planilha de 10 mil
 * linhas numa resposta só é o que derruba a requisição.
 */
export class AdminPageQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;
}

export class AdminSearchQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ description: 'Busca livre.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;
}

export class ListAdminOrganizationsQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({ enum: ORGANIZATION_STATUSES })
  @IsOptional()
  @IsIn(ORGANIZATION_STATUSES)
  status?: OrganizationStatus;

  @ApiPropertyOptional({ enum: PLAN_TYPES })
  @IsOptional()
  @IsIn(PLAN_TYPES)
  plan?: string;
}

export class ListAdminCustomersQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'INVITED', 'BLOCKED', 'REMOVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'INVITED', 'BLOCKED', 'REMOVED'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ enum: PLAN_TYPES })
  @IsOptional()
  @IsIn(PLAN_TYPES)
  plan?: string;
}

export class ListAdminOperatorsQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'DISABLED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED'])
  status?: 'ACTIVE' | 'DISABLED';

  @ApiPropertyOptional({ enum: PLATFORM_ROLES })
  @IsOptional()
  @IsIn(PLATFORM_ROLES)
  platformRole?: string;

  @ApiPropertyOptional({
    enum: PLATFORM_PERMISSIONS,
    description:
      'Só operadores cujo papel tem esta permissão — ex.: `support:manage` para quem pode assumir um chamado.',
  })
  @IsOptional()
  @IsIn(PLATFORM_PERMISSIONS)
  permission?: PlatformPermission;
}

export class ListAdminSubscriptionsQueryDto extends ListAdminOrganizationsQueryDto {}

export class ListAdminInvoicesQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({
    enum: ['PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED'],
  })
  @IsOptional()
  @IsIn(['PENDING', 'PAID', 'FAILED', 'CANCELED', 'EXPIRED'])
  status?: string;

  @ApiPropertyOptional({
    description: 'Só pendentes com vencimento no passado.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class ListAdminIntegrationsQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({ example: 'meta' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  provider?: string;

  @ApiPropertyOptional({
    enum: ['CONNECTED', 'DISCONNECTED', 'TOKEN_EXPIRED', 'ERROR'],
  })
  @IsOptional()
  @IsIn(['CONNECTED', 'DISCONNECTED', 'TOKEN_EXPIRED', 'ERROR'])
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;
}

export class ListAdminJobRunsQueryDto extends AdminPageQueryDto {
  @ApiPropertyOptional({ enum: ['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] })
  @IsOptional()
  @IsIn(['RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'])
  status?: string;

  @ApiPropertyOptional({ example: 'ads-ingest-full' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  jobName?: string;

  @ApiPropertyOptional({ description: '`RUNNING` com lease vencido.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  stalled?: boolean;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

/** `q` casa o nome do evento **ou** o nome da organização. */
export class ListAdminAuditLogsQueryDto extends AdminSearchQueryDto {
  @ApiPropertyOptional({ enum: ['BUSINESS', 'SECURITY'] })
  @IsOptional()
  @IsIn(['BUSINESS', 'SECURITY'])
  kind?: 'BUSINESS' | 'SECURITY';

  @ApiPropertyOptional({ enum: ['INFO', 'WARNING', 'CRITICAL'] })
  @IsOptional()
  @IsIn(['INFO', 'WARNING', 'CRITICAL'])
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
