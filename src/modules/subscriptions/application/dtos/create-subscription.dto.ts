import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';

export enum SubscriptionBillingProvider {
  STRIPE = 'STRIPE',
}

export class CreateSubscriptionInputDto {
  @ApiProperty({
    example: '8c3ccf45-d53a-45af-85ee-27659d082ad4',
    required: false,
    description:
      'Plano a ser assinado. Quando omitido, utiliza o plano selecionado no cadastro.',
  })
  @IsOptional()
  @IsUUID('4', { message: 'Plan id is invalid' })
  planId?: string;

  @ApiProperty({
    example: 'STRIPE',
    enum: SubscriptionBillingProvider,
    required: false,
    description:
      'Provedor de pagamento. Para o fluxo Stripe Elements, envie STRIPE.',
  })
  @IsOptional()
  @IsEnum(SubscriptionBillingProvider, {
    message: 'billingProvider must be STRIPE',
  })
  billingProvider?: SubscriptionBillingProvider;
}
