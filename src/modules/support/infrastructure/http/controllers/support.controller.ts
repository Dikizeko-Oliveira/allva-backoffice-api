import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { Account } from 'src/modules/accounts/domain/entities';
import { CurrentOrganization } from 'src/modules/organizations/infrastructure/http/decorators/current-organization.decorator';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { ThrottleLimit } from 'src/shared/infrastructure/http/throttling/throttle-policies';
import {
  SupportTicketCategoryValues,
  SupportTicketPriorityValues,
} from 'src/modules/support/domain/entities';
import {
  ListSupportTicketsOutputDto,
  ListSupportTicketsQueryDto,
  ReplySupportTicketInputDto,
  ReplySupportTicketOutputDto,
  SendSupportMessageInputDto,
  SendSupportMessageOutputDto,
  SupportOnboardingOutputDto,
  SupportTicketDetailOutputDto,
  SupportTicketsSummaryOutputDto,
} from 'src/modules/support/application/dtos';
import {
  GetSupportOnboardingUseCase,
  GetSupportTicketUseCase,
  GetSupportTicketsSummaryUseCase,
  ListSupportTicketsUseCase,
  ReplyToSupportTicketUseCase,
  SendSupportMessageUseCase,
} from 'src/modules/support/application/use-cases';

@ApiTags('Suporte')
@Controller('/api/v1/support')
@UseGuards(EntitlementGuard)
// Autenticado basta: uma conta em atraso de pagamento (GRACE_PERIOD/PAYMENT_REQUIRED)
// ainda precisa conseguir pedir ajuda — inclusive sobre o próprio atraso. Isso
// vale também para as leituras da Central: o plano que as libera é resolvido
// pelo **contratado** (ver `PlanEntitlementService`), então o atraso não tira
// de ninguém a lista dos próprios chamados.
@AuthenticatedOnly()
export class SupportController {
  constructor(
    private readonly sendSupportMessageUseCase: SendSupportMessageUseCase,
    private readonly listSupportTicketsUseCase: ListSupportTicketsUseCase,
    private readonly getSupportTicketsSummaryUseCase: GetSupportTicketsSummaryUseCase,
    private readonly getSupportTicketUseCase: GetSupportTicketUseCase,
    private readonly getSupportOnboardingUseCase: GetSupportOnboardingUseCase,
    private readonly replyToSupportTicketUseCase: ReplyToSupportTicketUseCase,
  ) {}

  @Post('messages')
  @HttpCode(HttpStatus.OK)
  // Mesma ordem de grandeza de `POST /organizations/invitations` — outra ação
  // autenticada que dispara e-mail. Evita que o Drawer vire um jeito barato de
  // floodar a caixa de suporte.
  @ThrottleLimit(10)
  @ApiOperation({
    summary:
      'Enviar mensagem de suporte (autenticado), com print opcional. Identidade e organização vêm do contexto autenticado, nunca do corpo.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['subject', 'message'],
      properties: {
        subject: { type: 'string' },
        message: { type: 'string' },
        category: { type: 'string', enum: [...SupportTicketCategoryValues] },
        priority: { type: 'string', enum: [...SupportTicketPriorityValues] },
        screenshot: {
          type: 'string',
          format: 'binary',
          description: 'Opcional — PNG/JPEG/WEBP/GIF, até 5 MB.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: SendSupportMessageOutputDto })
  @UseInterceptors(FileInterceptor('screenshot'))
  async sendMessage(
    @Body() dto: SendSupportMessageInputDto,
    @CurrentUser() user: Account,
    @CurrentOrganization() organization: OrganizationContext | undefined,
    @UploadedFile() screenshot?: Express.Multer.File,
  ): Promise<SendSupportMessageOutputDto> {
    return this.sendSupportMessageUseCase.execute({
      dto,
      accountId: user.id,
      organizationId: organization?.organizationId ?? null,
      attachment: screenshot,
    });
  }

  @Get('tickets')
  @ApiOperation({
    summary:
      'Listar chamados da organização ativa (Central de suporte — exige `support-dedicated-channel`).',
  })
  @ApiOkResponse({ type: ListSupportTicketsOutputDto })
  async listTickets(
    @Query() query: ListSupportTicketsQueryDto,
    @CurrentOrganization() organization: OrganizationContext | undefined,
  ): Promise<ListSupportTicketsOutputDto> {
    return this.listSupportTicketsUseCase.execute({
      query,
      organizationId: organization?.organizationId ?? null,
    });
  }

  /**
   * **Antes de `tickets/:code`, e isso não é estilo.** O Nest casa rotas na
   * ordem em que são declaradas: invertidas, `:code` engoliria `summary` e a
   * resposta seria um 404 de chamado inexistente.
   */
  @Get('tickets/summary')
  @ApiOperation({
    summary: 'Indicadores dos chamados da organização ativa (últimos 30 dias).',
  })
  @ApiOkResponse({ type: SupportTicketsSummaryOutputDto })
  async ticketsSummary(
    @CurrentOrganization() organization: OrganizationContext | undefined,
  ): Promise<SupportTicketsSummaryOutputDto> {
    return this.getSupportTicketsSummaryUseCase.execute({
      organizationId: organization?.organizationId ?? null,
    });
  }

  @Get('tickets/:code')
  @ApiOperation({
    summary:
      'Obter um chamado pelo código (`SUP-AAAAMMDD-XXXX`), com histórico e anexo.',
  })
  @ApiOkResponse({ type: SupportTicketDetailOutputDto })
  async getTicket(
    @Param('code') code: string,
    @CurrentOrganization() organization: OrganizationContext | undefined,
  ): Promise<SupportTicketDetailOutputDto> {
    return this.getSupportTicketUseCase.execute({
      code,
      organizationId: organization?.organizationId ?? null,
    });
  }

  @Post('tickets/:code/messages')
  @HttpCode(HttpStatus.CREATED)
  // Mesmo teto de `POST messages`: responder também dispara trabalho humano
  // do outro lado, e o custo de uma enxurrada é o mesmo.
  @ThrottleLimit(10)
  @ApiOperation({
    summary:
      'Responder num chamado existente, com print opcional. Responder num chamado resolvido o reabre; encerrado recusa.',
  })
  @ApiConsumes('multipart/form-data', 'application/json')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['message'],
      properties: {
        message: { type: 'string' },
        screenshot: {
          type: 'string',
          format: 'binary',
          description: 'Opcional — PNG/JPEG/WEBP/GIF, até 5 MB.',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: ReplySupportTicketOutputDto })
  @UseInterceptors(FileInterceptor('screenshot'))
  async replyToTicket(
    @Param('code') code: string,
    @Body() dto: ReplySupportTicketInputDto,
    @CurrentUser() user: Account,
    @CurrentOrganization() organization: OrganizationContext | undefined,
    @UploadedFile() screenshot?: Express.Multer.File,
  ): Promise<ReplySupportTicketOutputDto> {
    return this.replyToSupportTicketUseCase.execute({
      code,
      dto,
      accountId: user.id,
      organizationId: organization?.organizationId ?? null,
      attachment: screenshot,
    });
  }

  @Get('onboarding')
  @ApiOperation({
    summary:
      'Checklist de primeiros passos da organização ativa (exige `support-onboarding`).',
  })
  @ApiOkResponse({ type: SupportOnboardingOutputDto })
  async onboarding(
    @CurrentUser() user: Account,
    @CurrentOrganization() organization: OrganizationContext | undefined,
  ): Promise<SupportOnboardingOutputDto> {
    return this.getSupportOnboardingUseCase.execute({
      accountId: user.id,
      organizationId: organization?.organizationId ?? null,
    });
  }
}
