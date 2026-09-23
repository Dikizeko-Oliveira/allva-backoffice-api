import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class CreatePreferenceInputDto {
  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  notificationByEmail?: boolean;

  @ApiProperty({ example: false, required: false })
  @IsOptional()
  @IsBoolean()
  dailyResume?: boolean;

  @ApiProperty({
    example: true,
    required: false,
    description:
      'Alertas de desperdicio/orcamento por e-mail. Apenas WARNING e CRITICAL sao enviados; INFO fica so no painel.',
  })
  @IsOptional()
  @IsBoolean()
  alertNotifications?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  promotionNotifications?: boolean;

  @ApiProperty({ example: true, required: false })
  @IsOptional()
  @IsBoolean()
  productNewsNotification?: boolean;
}

export class CreatePreferenceOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;
}
