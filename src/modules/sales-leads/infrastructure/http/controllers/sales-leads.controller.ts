import { Body, Controller, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ThrottleLimit } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import { Public } from 'src/modules/auth/infrastructure/http/decorators/public.decorator';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import {
  CreateSalesLeadInputDto,
  CreateSalesLeadOutputDto,
} from '../../../application/dtos';
import { CreateSalesLeadUseCase } from '../../../application/use-cases';

type AuthenticatedUser = { id: string; email: string } | undefined;

/**
 * O formulário de `/sales` — **e só ele**.
 *
 * Listar, ler e mover leads saíram daqui para `AdminSalesLeadsController`. As
 * três exigiam apenas sessão válida, o que punha o pipeline comercial inteiro ao
 * alcance de qualquer cliente logado: base de leads de um lado, e
 * `CLOSED_WON` — que provisiona uma organização Enterprise — do outro.
 *
 * A criação continua pública porque é o formulário aberto do site. O que ela
 * aceita já é o mínimo, e `@ThrottleLimit(5)` é o que a protege.
 */

@ApiTags('Sales Leads')
@Controller('/api/v1/sales-leads')
export class SalesLeadsController {
  constructor(
    private readonly createSalesLeadUseCase: CreateSalesLeadUseCase,
  ) {}

  @Post()
  @Public()
  @ThrottleLimit(5)
  @ApiOperation({
    summary:
      'Criar lead de vendas (público). Se autenticado, o account_id é associado pelo backend via JWT.',
  })
  @ApiCreatedResponse({ type: CreateSalesLeadOutputDto })
  async create(
    @Body() dto: CreateSalesLeadInputDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CreateSalesLeadOutputDto> {
    // account_id is resolved from the authenticated session only — never trusted
    // from the request body.
    const accountId = user?.id ?? null;
    return this.createSalesLeadUseCase.execute(dto, accountId);
  }
}
