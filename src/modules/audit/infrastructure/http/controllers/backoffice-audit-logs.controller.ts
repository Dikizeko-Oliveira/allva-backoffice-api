import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Operator } from 'src/modules/auth/domain/entities';
import { CurrentOperator } from 'src/modules/auth/infrastructure/http/decorators/current-operator.decorator';
import {
  ListBackofficeAuditLogsOutputDto,
  ListBackofficeAuditLogsQueryDto,
} from 'src/modules/audit/application/dtos';
import { ListBackofficeAuditLogsUseCase } from 'src/modules/audit/application/use-cases';

@ApiTags('Auditoria')
@ApiBearerAuth()
@Controller('/api/v1/audit-logs')
export class BackofficeAuditLogsController {
  constructor(
    private readonly listBackofficeAuditLogsUseCase: ListBackofficeAuditLogsUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Trilha de auditoria do processo interno',
    description:
      'Exige `audit:read`. Só as escritas do backoffice-api — a trilha do produto continua no `allva-api`.',
  })
  @ApiOkResponse({ type: ListBackofficeAuditLogsOutputDto })
  async list(
    @CurrentOperator() operator: Operator,
    @Query() query: ListBackofficeAuditLogsQueryDto,
  ): Promise<ListBackofficeAuditLogsOutputDto> {
    return this.listBackofficeAuditLogsUseCase.execute(operator, query);
  }
}
