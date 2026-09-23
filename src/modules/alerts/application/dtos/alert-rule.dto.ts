import { ApiProperty, PartialType } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  ALERT_CHANNELS,
  type AlertChannel,
} from 'src/modules/alerts/domain/entities';
import { PLATFORM_PERMISSIONS } from 'src/modules/auth/domain/platform-permissions';

export class CreateAlertRuleInputDto {
  @ApiProperty({ example: 'support.sla_breached' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  source: string;

  @ApiProperty({ example: '>= 3' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  threshold: string;

  @ApiProperty({ enum: ALERT_CHANNELS })
  @IsIn(ALERT_CHANNELS)
  channel: AlertChannel;

  @ApiProperty({ example: '#suporte-alertas' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(320)
  target: string;

  @ApiProperty({
    enum: PLATFORM_PERMISSIONS,
    description: 'Quem vê os disparos desta regra.',
  })
  @IsIn(PLATFORM_PERMISSIONS)
  requiredPermission: string;

  @ApiProperty({ required: false, nullable: true, description: 'Opaco.' })
  @IsOptional()
  quietHours?: unknown;

  @ApiProperty({ required: false, default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAlertRuleInputDto extends PartialType(
  CreateAlertRuleInputDto,
) {}

export class AlertRuleOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  source: string;

  @ApiProperty()
  threshold: string;

  @ApiProperty({ enum: ALERT_CHANNELS })
  channel: AlertChannel;

  @ApiProperty()
  target: string;

  @ApiProperty()
  requiredPermission: string;

  @ApiProperty({ nullable: true })
  quietHours: unknown;

  @ApiProperty()
  active: boolean;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
