import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

export class ListAlertEventsQueryDto extends PageQueryDto {
  @ApiProperty({
    required: false,
    enum: ['true', 'false'],
    description: 'Ausente = todos.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  acknowledged?: 'true' | 'false';
}

export class AlertEventOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  ruleId: string;

  @ApiProperty()
  source: string;

  @ApiProperty()
  severity: string;

  @ApiProperty({ nullable: true })
  payload: unknown;

  @ApiProperty()
  requiredPermission: string;

  @ApiProperty({ nullable: true })
  acknowledgedBy: string | null;

  @ApiProperty({ nullable: true })
  acknowledgedAt: Date | null;

  @ApiProperty()
  createdAt: Date;
}

export class ListAlertEventsOutputDto {
  @ApiProperty({ type: [AlertEventOutputDto] })
  items: AlertEventOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
