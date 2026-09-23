import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

export class TransferOrganizationOwnershipInputDto {
  @ApiProperty({
    example: 'uuid',
    description: 'Account id of the member who will become the new OWNER.',
  })
  @IsString()
  @IsUUID()
  newOwnerAccountId: string;
}

export class TransferOrganizationOwnershipOutputDto {
  @ApiProperty({ example: 'uuid' })
  organizationId: string;

  @ApiProperty({ example: 'uuid' })
  newOwnerAccountId: string;

  @ApiProperty({ example: 'uuid' })
  previousOwnerAccountId: string;
}
