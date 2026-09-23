import { ApiProperty } from '@nestjs/swagger';

export class CancelSubscriptionOutputDto {
  @ApiProperty({
    example: true,
    description: 'Indica se a assinatura foi cancelada com sucesso',
  })
  canceled: boolean;
}
