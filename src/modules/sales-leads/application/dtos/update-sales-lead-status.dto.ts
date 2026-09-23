import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SalesLeadStatusValues } from '../../domain/entities';

enum SalesLeadStatusInput {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  QUALIFIED = 'QUALIFIED',
  PROPOSAL_SENT = 'PROPOSAL_SENT',
  NEGOTIATION = 'NEGOTIATION',
  CLOSED_WON = 'CLOSED_WON',
  CLOSED_LOST = 'CLOSED_LOST',
}

export class UpdateSalesLeadStatusInputDto {
  @ApiProperty({
    enum: SalesLeadStatusInput,
    example: SalesLeadStatusInput.QUALIFIED,
  })
  @IsEnum(SalesLeadStatusInput, {
    message: `Status must be one of: ${SalesLeadStatusValues.join(', ')}`,
  })
  status: SalesLeadStatusInput;
}

export class UpdateSalesLeadStatusOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'QUALIFIED' })
  status: string;
}
