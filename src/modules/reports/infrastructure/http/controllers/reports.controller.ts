import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import {
  EmailReportUseCase,
  GenerateReportUseCase,
  GetReportDownloadUseCase,
  ListReportTemplatesUseCase,
  ListReportsUseCase,
} from '../../../application/use-cases/report-use-cases';

class GenerateReportBodyDto {
  @ApiProperty({ example: 'performance-summary' })
  @IsString()
  @IsNotEmpty()
  templateKey!: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsObject()
  params?: Record<string, unknown>;
}

class EmailReportBodyDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: 'to must be a valid email address' })
  to!: string;
}

@ApiTags('Reports')
@ApiBearerAuth('access-token')
@Controller('/api/v1/reports')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
export class ReportsController {
  constructor(
    private readonly templates: ListReportTemplatesUseCase,
    private readonly generate: GenerateReportUseCase,
    private readonly list: ListReportsUseCase,
    private readonly download: GetReportDownloadUseCase,
    private readonly email: EmailReportUseCase,
  ) {}

  @Get('/templates')
  @ApiOperation({
    summary: 'Listar templates de relatório disponíveis',
    description:
      'O modelo de período traz `periodOptions` com os intervalos que o ' +
      'histórico do plano desta organização alcança.',
  })
  listTemplates(@CurrentUser() user: Account) {
    return this.templates.execute(user.id);
  }

  @Post('/generate')
  @ApiOperation({ summary: 'Gerar um relatório (async)' })
  async generateReport(
    @CurrentUser() user: Account,
    @Body() dto: GenerateReportBodyDto,
  ) {
    return this.generate.execute(user.id, dto.templateKey, dto.params);
  }

  @Get()
  @ApiOperation({ summary: 'Listar relatórios do owner' })
  async listAll(@CurrentUser() user: Account) {
    return this.list.execute(user.id);
  }

  @Get('/:id/download')
  @ApiOperation({ summary: 'Obter URL de download do relatório' })
  async downloadReport(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.download.execute(user.id, id);
  }

  @Post('/:id/send-email')
  @ApiOperation({ summary: 'Enviar relatório por email' })
  async sendEmail(
    @CurrentUser() user: Account,
    @Param('id') id: string,
    @Body() dto: EmailReportBodyDto,
  ) {
    return this.email.execute(user.id, id, { to: dto.to });
  }
}
