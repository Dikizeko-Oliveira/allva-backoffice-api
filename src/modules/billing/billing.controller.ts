import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional, IsString } from 'class-validator';
import { Account } from 'src/modules/accounts/domain/entities';
import { BillingCard } from 'src/modules/subscriptions/domain/entities/billing-card.entity';
import { CurrentUser } from 'src/modules/auth/infrastructure/http/decorators/current-user.decorator';
import { EntitlementGuard } from 'src/modules/subscriptions/access/infrastructure/http/guards/entitlement.guard';
import { AuthenticatedOnly } from 'src/modules/subscriptions/access/infrastructure/http/decorators/authenticated-only.decorator';
import { RequireAccessStatuses } from 'src/modules/subscriptions/access/infrastructure/http/decorators/require-access-statuses.decorator';
import { GetSubscriptionBillingCardUseCase } from 'src/modules/subscriptions/application/use-cases/get-subscription-billing-card.usecase';
import { UpdateSubscriptionBillingCardUseCase } from 'src/modules/subscriptions/application/use-cases/update-subscription-billing-card.usecase';
import { ListSubscriptionsUseCase } from 'src/modules/subscriptions/application/use-cases/list-subscriptions.usecase';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';
import { ListInvoicesUseCase } from 'src/modules/invoices/application/use-cases/list-invoices.usecase';
import { StripeService } from 'src/modules/subscriptions/infrastructure/services/stripe.service';
import { ChangeSubscriptionUseCase } from './change-subscription.usecase';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { GetBillingUsageUseCase } from './get-billing-usage.usecase';
import { MemberUsageService } from './member-usage.service';

class UpdatePaymentMethodInputDto {
  @ApiProperty({
    example: 'pm_1QabcdEFGH',
    description:
      'Id do payment method do Stripe, obtido confirmando o SetupIntent de ' +
      'POST /api/v1/payments/stripe/setup-intent no Stripe.js.',
  })
  @IsString()
  paymentMethodId: string;
}

class ChangeSubscriptionInputDto {
  @ApiProperty({ example: 'uuid-plan-id' })
  @IsString()
  planId: string;
}

class ListInvoicesQueryDto {
  @ApiProperty({ required: false, enum: ['7d', '30d', '90d'] })
  @IsOptional()
  @IsIn(['7d', '30d', '90d'])
  period?: '7d' | '30d' | '90d';
}

class PaymentMethodDto {
  @ApiProperty({ example: 'a3f1c8e2-0d4b-4f9a-9c11-8b2d5e6f7a90' })
  id: string;

  @ApiProperty({ example: 'visa', required: false })
  brand?: string;

  @ApiProperty({ example: '4242' })
  last4: string;

  @ApiProperty({ example: 12 })
  expiryMonth: number;

  @ApiProperty({ example: 2030 })
  expiryYear: number;

  @ApiProperty({ enum: ['CREDIT', 'DEBIT'], example: 'CREDIT' })
  type: 'CREDIT' | 'DEBIT';
}

/**
 * Envelope so "no card on file" is expressible as JSON. Returning a bare `null`
 * made Nest answer 200 with an **empty body**, which is not parseable JSON — a
 * client calling `res.json()` got a syntax error on a perfectly normal state.
 */
class PaymentMethodResponseDto {
  @ApiProperty({
    type: PaymentMethodDto,
    nullable: true,
    description: 'null quando a conta ainda nao tem cartao salvo.',
  })
  paymentMethod: PaymentMethodDto | null;
}

class InvoicePdfResponseDto {
  @ApiProperty({
    example: 'https://files.stripe.com/invoices/.../invoice.pdf',
    description: 'URL temporaria do PDF hospedado pelo Stripe.',
  })
  url: string;
}

@ApiTags('Billing')
@Controller('/api/v1/billing')
@UseGuards(EntitlementGuard)
@AuthenticatedOnly()
export class BillingController {
  constructor(
    private readonly listSubscriptionsUseCase: ListSubscriptionsUseCase,
    private readonly getSubscriptionBillingCardUseCase: GetSubscriptionBillingCardUseCase,
    private readonly updateSubscriptionBillingCardUseCase: UpdateSubscriptionBillingCardUseCase,
    private readonly changeSubscriptionUseCase: ChangeSubscriptionUseCase,
    private readonly listInvoicesUseCase: ListInvoicesUseCase,
    private readonly getBillingUsageUseCase: GetBillingUsageUseCase,
    private readonly memberUsage: MemberUsageService,
    private readonly scope: OwnerScopeResolverService,
    private readonly invoicesRepository: InvoicesRepositoryInterface,
    private readonly stripeService: StripeService,
  ) {}

  @Get('usage')
  @ApiOperation({ summary: 'Consultar o consumo do ciclo corrente' })
  async getUsage(@CurrentUser() user: Account) {
    return this.getBillingUsageUseCase.execute(user.id);
  }

  /**
   * O consumo das cotas por membro — **atribuição, não segunda parede**.
   *
   * A cota continua sendo da organização: dividi-la por assento bloquearia um
   * usuário enquanto o time tem folga. O que faltava era saber de quem foi, e o
   * dado já estava gravado em `account_id` desde sempre.
   *
   * Escopo de conta devolve lista vazia: sem organização não há time a atribuir,
   * e o único consumidor possível é quem está perguntando.
   */
  @Get('usage/members')
  @ApiOperation({ summary: 'Consumo das cotas por membro no mês atual' })
  async getMemberUsage(@CurrentUser() user: Account) {
    const owner = await this.scope.resolveForAccount(user.id);
    if (!owner.organizationId) return { members: [] };

    return {
      members: await this.memberUsage.forOrganization(owner.organizationId),
    };
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Consultar assinatura atual' })
  async getSubscription(@CurrentUser() user: Account) {
    return this.listSubscriptionsUseCase.execute(user.id);
  }

  @Get('payment-method')
  @ApiOperation({ summary: 'Consultar método de pagamento da assinatura' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  async getPaymentMethod(
    @CurrentUser() user: Account,
  ): Promise<PaymentMethodResponseDto> {
    const card = await this.getSubscriptionBillingCardUseCase.execute(user.id);

    return { paymentMethod: card ? this.toPaymentMethodDto(card) : null };
  }

  @Put('payment-method')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Atualizar método de pagamento da assinatura' })
  @ApiOkResponse({ type: PaymentMethodResponseDto })
  async updatePaymentMethod(
    @CurrentUser() user: Account,
    @Body() dto: UpdatePaymentMethodInputDto,
  ): Promise<PaymentMethodResponseDto> {
    // No previous card is required: the SetupIntent creates the payment method, so
    // this is also the path a customer uses to add their first one.
    const updated = await this.updateSubscriptionBillingCardUseCase.execute({
      accountId: user.id,
      paymentMethodId: dto.paymentMethodId,
    });

    // Same envelope as the GET: one resource, one shape for the client to map.
    return { paymentMethod: this.toPaymentMethodDto(updated) };
  }

  private toPaymentMethodDto(card: BillingCard): PaymentMethodDto {
    return {
      id: card.id,
      brand: card.brand,
      last4: card.lastFourDigits,
      expiryMonth: card.expirationMonth,
      expiryYear: card.expirationYear,
      type: card.paymentMethod === 'DEBIT_CARD' ? 'DEBIT' : 'CREDIT',
    };
  }

  @Post('subscription/change')
  @HttpCode(HttpStatus.OK)
  @RequireAccessStatuses('ALLOWED', 'GRACE_PERIOD')
  @ApiOperation({
    summary: 'Alterar plano da assinatura (upgrade ou downgrade)',
  })
  async changeSubscription(
    @CurrentUser() user: Account,
    @Body() dto: ChangeSubscriptionInputDto,
  ) {
    return this.changeSubscriptionUseCase.execute({
      accountId: user.id,
      planId: dto.planId,
    });
  }

  @Get('invoices')
  @ApiOperation({ summary: 'Listar faturas da conta' })
  async listInvoices(
    @CurrentUser() user: Account,
    @Query() query: ListInvoicesQueryDto,
  ) {
    return this.listInvoicesUseCase.execute(user.id, query.period);
  }

  @Get('invoices/:id/pdf')
  @ApiOperation({
    summary: 'Obter URL do PDF da fatura',
  })
  @ApiOkResponse({ type: InvoicePdfResponseDto })
  async getInvoicePdf(
    @CurrentUser() user: Account,
    @Param('id') id: string,
  ): Promise<InvoicePdfResponseDto> {
    const invoice = await this.invoicesRepository.findById(id);

    if (!invoice || invoice.accountId !== user.id) {
      throw new NotFoundException({
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found.',
      });
    }

    if (invoice.provider !== 'STRIPE' || !invoice.externalInvoiceId) {
      throw new NotFoundException({
        code: 'PDF_NOT_AVAILABLE',
        message: 'PDF is only available for Stripe invoices.',
      });
    }

    const pdfUrl = await this.stripeService.getInvoicePdfUrl(
      invoice.externalInvoiceId,
    );

    if (!pdfUrl) {
      throw new NotFoundException({
        code: 'PDF_NOT_AVAILABLE',
        message: 'PDF URL not available for this invoice.',
      });
    }

    // Returns the URL instead of a 302. The caller is a server-side BFF, and a
    // redirect there is followed transparently — the client received the PDF bytes
    // where it expected JSON, and never got to see the link it asked for.
    return { url: pdfUrl };
  }
}
