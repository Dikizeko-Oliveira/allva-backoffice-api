import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

enum DowngradePlanType {
  STARTER = 'STARTER',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

export class DowngradeSubscriptionInputDto {
  @ApiProperty({
    enum: DowngradePlanType,
    example: DowngradePlanType.STARTER,
    description:
      'Plano pago de destino para downgrade. FREE não é permitido neste fluxo.',
  })
  @IsEnum(DowngradePlanType, {
    message: 'Plan type must be STARTER, PRO or ENTERPRISE',
  })
  planType: DowngradePlanType;
}

export class DowngradeSubscriptionOutputDto {}
