import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class LinkAdAccountInputDto {
  @ApiProperty({ example: 'act_123456789' })
  @IsString({ message: 'externalAccountId must be a string' })
  externalAccountId!: string;

  @ApiProperty({ example: 'Conta Principal', required: false })
  @IsOptional()
  @IsString({ message: 'name must be a string' })
  name?: string;
}

export class LinkAdAccountResponseDto {
  @ApiProperty({ example: 'uuid-ad-account-id' })
  id!: string;
}

export class UnlinkAdAccountResponseDto {
  @ApiProperty({
    example: false,
    description: 'Vinculada e não congelada. Após desvincular, sempre falso.',
  })
  active!: boolean;

  @ApiProperty({ example: 'uuid-ad-account-id' })
  id!: string;
}

export class DisconnectIntegrationResponseDto {
  @ApiProperty({ example: 'uuid-integration-id' })
  id!: string;

  @ApiProperty({ example: 'DISCONNECTED' })
  status!: string;
}
