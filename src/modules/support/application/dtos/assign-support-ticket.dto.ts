import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, ValidateIf } from 'class-validator';

export class AssignSupportTicketInputDto {
  @ApiProperty({
    required: false,
    nullable: true,
    description: 'O novo responsável. `null` (ou ausente) desatribui.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  toOperatorId?: string | null;

  @ApiProperty({
    required: false,
    nullable: true,
    description:
      'Obrigatório ao **repassar** um chamado que já tinha responsável.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(1000)
  reason?: string | null;
}
