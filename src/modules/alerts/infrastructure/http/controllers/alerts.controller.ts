import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import {
  DismissAlertUseCase,
  GetAlertUseCase,
  ListAlertsUseCase,
  MarkAlertReadUseCase,
  MarkAllAlertsReadUseCase,
  ResolveAlertUseCase,
} from '../../../application/use-cases/alert-use-cases';
import {
  AlertSeverity,
  AlertState,
} from '../../../domain/ports/alerts.repository';

@ApiTags('Alerts')
@ApiBearerAuth('access-token')
@Controller('/api/v1/alerts')
@UseGuards(EntitlementGuard)
@RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
export class AlertsController {
  constructor(
    private readonly listAlerts: ListAlertsUseCase,
    private readonly getAlertUseCase: GetAlertUseCase,
    private readonly markOneRead: MarkAlertReadUseCase,
    private readonly markAllReadUseCase: MarkAllAlertsReadUseCase,
    private readonly dismissAlert: DismissAlertUseCase,
    private readonly resolveAlert: ResolveAlertUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Listar alertas do usuário',
    description:
      'Ordenado por severidade (CRITICAL primeiro) e depois por data. ' +
      'Por padrão retorna apenas alertas abertos — use `state` para ver dispensados/encerrados.',
  })
  @ApiQuery({ name: 'isRead', required: false, type: Boolean })
  @ApiQuery({
    name: 'severity',
    required: false,
    enum: ['INFO', 'WARNING', 'CRITICAL'],
  })
  @ApiQuery({
    name: 'state',
    required: false,
    enum: ['OPEN', 'DISMISSED', 'RESOLVED', 'ALL'],
    description: 'Padrão: OPEN',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  async getAlerts(
    @CurrentUser() user: Account,
    @Query('isRead') isRead?: string,
    @Query('severity') severity?: string,
    @Query('state') state?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.listAlerts.execute(user.id, {
      isRead: isRead !== undefined ? isRead === 'true' : undefined,
      severity: severity as AlertSeverity | undefined,
      state: this.parseState(state),
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  /** Unknown values fall back to OPEN rather than 400 — this is a display filter. */
  private parseState(state?: string): AlertState {
    const allowed: AlertState[] = ['OPEN', 'DISMISSED', 'RESOLVED', 'ALL'];

    return allowed.includes(state as AlertState)
      ? (state as AlertState)
      : 'OPEN';
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de um alerta' })
  async getAlert(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.getAlertUseCase.execute(user.id, id);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Marcar alerta como lido' })
  async readOne(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.markOneRead.execute(user.id, id);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Marcar todos os alertas como lidos' })
  async readAll(@CurrentUser() user: Account) {
    return this.markAllReadUseCase.execute(user.id);
  }

  @Patch(':id/dismiss')
  @ApiOperation({
    summary: 'Dispensar alerta',
    description:
      'Remove o alerta da fila do usuário sem afirmar que o problema acabou. ' +
      'Idempotente. Se a condição voltar a ser detectada, um novo alerta é criado.',
  })
  async dismiss(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.dismissAlert.execute(user.id, id);
  }

  @Patch(':id/resolve')
  @ApiOperation({
    summary: 'Encerrar alerta',
    description:
      'Marca a condição que gerou o alerta como resolvida. Idempotente. ' +
      'Encerrar reabre a janela de deduplicação: se o problema reaparecer, ' +
      'vira um alerta novo (com novo e-mail).',
  })
  async resolve(@CurrentUser() user: Account, @Param('id') id: string) {
    return this.resolveAlert.execute(user.id, id);
  }
}
