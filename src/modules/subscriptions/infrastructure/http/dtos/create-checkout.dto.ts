import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty } from 'class-validator';

export enum CheckoutPlanType {
  STARTER = 'STARTER',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

export class CreateCheckoutInputDto {
  @ApiProperty({
    enum: CheckoutPlanType,
    example: CheckoutPlanType.PRO,
    description: 'Tipo do plano a ser assinado (STARTER, PRO ou ENTERPRISE)',
  })
  @IsEnum(CheckoutPlanType, {
    message: 'Plan type must be STARTER, PRO or ENTERPRISE',
  })
  @IsNotEmpty()
  planType: CheckoutPlanType;
}

export class CreateCheckoutOutputDto {
  @ApiProperty({
    example: 'https://checkout.stripe.com/c/pay/cs_test_123...',
    description: 'URL de redirecionamento para o checkout do Stripe',
  })
  checkoutUrl: string;
}
