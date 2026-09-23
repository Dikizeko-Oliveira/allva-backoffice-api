import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * @deprecated Prefer POST /integrations/:platform/accounts with LinkAdAccountInputDto.
 */
export class CreateAdAccountInputDto {
  @ApiProperty({ example: 'uuid-integration-id' })
  @IsString()
  integrationId!: string;

  @ApiProperty({ example: 'meta' })
  @IsString()
  provider!: string;

  @ApiProperty({ example: 'act_123456789' })
  @IsString()
  externalAccountId!: string;

  @ApiProperty({ example: 'Conta Principal' })
  @IsString()
  name!: string;

  @ApiProperty({ example: 'BRL' })
  @IsString()
  currency!: string;

  @ApiProperty({ example: 'America/Sao_Paulo' })
  @IsString()
  timezone!: string;

  @ApiProperty({ example: 'act_123456789', required: false, deprecated: true })
  @IsOptional()
  @IsString()
  accountId?: string;
}

export class CreateAdAccountOutputDto {
  @ApiProperty({ example: 'uuid' })
  id!: string;
}
