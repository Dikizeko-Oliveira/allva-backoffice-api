import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsOptional, IsString } from 'class-validator';

export enum ProviderTypeDto {
  GOOGLE = 'GOOGLE',
  META = 'META',
  TIKTOK = 'TIKTOK',
}

export class CreateIntegrationInputDto {
  @ApiProperty({ example: 'Meta Business', required: false })
  @IsOptional()
  @IsString({ message: 'Name must be a string' })
  name?: string;

  @ApiProperty({ example: 'meta' })
  @IsString({ message: 'Provider must be a string and is required' })
  provider!: string;

  @ApiProperty({ enum: ProviderTypeDto, example: ProviderTypeDto.META })
  @IsEnum(ProviderTypeDto, {
    message: 'Provider type must be GOOGLE, META or TIKTOK',
  })
  providerType!: ProviderTypeDto;

  @ApiProperty({ example: 'access-token' })
  @IsString({ message: 'Access token must be a string and is required' })
  accessToken!: string;

  @ApiProperty({ example: 'refresh-token' })
  @IsOptional()
  @IsString({ message: 'Refresh token must be a string' })
  refreshToken?: string;

  @ApiProperty({ example: '2026-12-31T23:59:59.000Z' })
  @IsDateString({}, { message: 'Expires at must be a valid date string' })
  expiresAt!: string;
}

export class CreateIntegrationOutputDto {
  @ApiProperty({ example: 'uuid' })
  id!: string;
}
