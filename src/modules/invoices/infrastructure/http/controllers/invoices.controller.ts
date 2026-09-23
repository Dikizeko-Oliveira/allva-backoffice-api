import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import {
  CreateInvoiceInputDto,
  CreateInvoiceOutputDto,
  ListInvoicesOutputDto,
  UpdateInvoiceStatusInputDto,
  UpdateInvoiceStatusOutputDto,
} from 'src/modules/invoices/application/dtos';
import {
  CreateInvoiceUseCase,
  ListInvoicesUseCase,
  UpdateInvoiceStatusUseCase,
} from 'src/modules/invoices/application/use-cases';
import { DeprecatedEndpoint } from 'src/shared/infrastructure/http/deprecated-endpoint.decorator';

/**
 * Back-office de faturas (PLAN.md M-3 / E-7).
 *
 * O M-3 consolidou `/billing`, `/payments/stripe` e `/subscriptions` e não
 * enxergou esta quarta superfície. A divisão agora é explícita:
 *
 * - **`POST /` e `PUT /:id/status`** são operações de **operador**, sem
 *   equivalente em `/billing` — ninguém emite ou corrige fatura pelo painel do
 *   cliente. Ficam aqui.
 * - **`GET /`** era duplicata estrita de `GET /billing/invoices`: mesmo use
 *   case, mesma conta, só sem o filtro de período. Está descontinuada.
 */
@ApiTags('Gerenciar Faturas')
@Controller('/api/v1/invoices')
@UseGuards(EntitlementGuard)
@AuthenticatedOnly()
export class InvoicesController {
  constructor(
    private readonly createInvoiceUseCase: CreateInvoiceUseCase,
    private readonly listInvoicesUseCase: ListInvoicesUseCase,
    private readonly updateInvoiceStatusUseCase: UpdateInvoiceStatusUseCase,
  ) {}

  @Get()
  @DeprecatedEndpoint({
    replacedBy: 'GET /api/v1/billing/invoices',
    note:
      'Mesmo `ListInvoicesUseCase` e mesma resposta. A rota canônica ainda ' +
      'aceita o filtro `?period=7d|30d|90d`, que esta nunca expôs.',
  })
  async listInvoices(
    @CurrentUser() user: Account,
  ): Promise<ListInvoicesOutputDto> {
    const accountId = user.id;

    return this.listInvoicesUseCase.execute(accountId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Operador] Criar invoice' })
  async createInvoice(
    @Body() dto: CreateInvoiceInputDto,
    @CurrentUser() user: Account,
  ): Promise<CreateInvoiceOutputDto> {
    const accountId = user.id;

    return this.createInvoiceUseCase.execute(dto, accountId);
  }

  @Put('/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '[Operador] Corrigir status do invoice',
    description:
      'Exige a permissão de plataforma `billing:manage`. O ciclo normal é dirigido pelos ' +
      'webhooks do Stripe; esta rota existe para correção manual e respeita a ' +
      'máquina de estados (PAID/CANCELED/EXPIRED são terminais). Toda mudança ' +
      'gera um evento `invoice.status_changed` na auditoria.',
  })
  @ApiForbiddenResponse({
    description: 'ACCOUNT_NOT_AUTHORIZED — o dono da fatura não pode alterá-la',
  })
  @ApiConflictResponse({
    description: 'INVALID_INVOICE_STATUS_TRANSITION',
  })
  async updateInvoiceStatus(
    @Param('id') id: string,
    @Body() dto: UpdateInvoiceStatusInputDto,
    @CurrentUser() user: Account,
  ): Promise<UpdateInvoiceStatusOutputDto> {
    const accountId = user.id;

    return this.updateInvoiceStatusUseCase.execute(id, dto, accountId);
  }
}
