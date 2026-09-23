import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

export class CreateInvoiceInputDto {
  @IsString({ message: 'accountId must be a valid uuid' })
  @ApiProperty({ example: 'uuid' })
  accountId: string;

  @IsString({ message: 'planId must be a valid uuid' })
  @ApiProperty({ example: 'uuid' })
  planId: string;

  @IsString({ message: 'subscriptionId must be a valid uuid' })
  @ApiProperty({ example: 'uuid' })
  subscriptionId: string;

  @IsString({ message: 'provider must be a string' })
  @ApiProperty({ example: 'STRIPE' })
  provider: string;

  @IsString({ message: 'Number must be a string' })
  @ApiProperty({ example: 'INV-0001' })
  number: string;

  @IsString({ message: 'externalReference must be a string' })
  @ApiProperty({ example: 'PAY-ABC123', required: false })
  externalReference?: string;
}

export class CreateInvoiceOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;
}
