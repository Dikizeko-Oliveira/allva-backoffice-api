import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SanitizeEmail, SanitizeText } from '../validators/sanitize.transform';
import { IsCorporateEmail } from '../validators/is-corporate-email.validator';

enum LeadPlatform {
  META = 'META',
  GOOGLE = 'GOOGLE',
  TIKTOK = 'TIKTOK',
}

export class CreateSalesLeadInputDto {
  @ApiProperty({ example: 'Acme Inc' })
  @SanitizeText()
  @IsString({ message: 'Company name must be a string and is required' })
  @MinLength(2, { message: 'Company name must have at least 2 characters' })
  @MaxLength(200, { message: 'Company name must have at most 200 characters' })
  companyName: string;

  @ApiProperty({ example: 'jane@acme.com' })
  @SanitizeEmail()
  @IsEmail({}, { message: 'Work email must be a valid email and is required' })
  @MaxLength(320, { message: 'Work email must have at most 320 characters' })
  @IsCorporateEmail()
  workEmail: string;

  @ApiProperty({ example: 'Jane Doe' })
  @SanitizeText()
  @IsString({ message: 'Full name must be a string and is required' })
  @MinLength(2, { message: 'Full name must have at least 2 characters' })
  @MaxLength(150, { message: 'Full name must have at most 150 characters' })
  fullName: string;

  @ApiProperty({ example: '+5511999999999', required: false })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Phone must be a string' })
  @MaxLength(30, { message: 'Phone must have at most 30 characters' })
  phone?: string;

  @ApiProperty({ example: 15000.5, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'Estimated monthly spend must be a number' },
  )
  @Min(0, { message: 'Estimated monthly spend cannot be negative' })
  @Max(1_000_000_000, { message: 'Estimated monthly spend is too large' })
  estimatedMonthlySpend?: number;

  @ApiProperty({ example: 25, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Team size must be an integer' })
  @Min(1, { message: 'Team size must be at least 1' })
  @Max(1_000_000, { message: 'Team size is too large' })
  teamSize?: number;

  @ApiProperty({
    enum: LeadPlatform,
    isArray: true,
    example: [LeadPlatform.META, LeadPlatform.GOOGLE],
    required: false,
  })
  @IsOptional()
  @IsArray({ message: 'Platforms must be an array' })
  @ArrayMaxSize(10, { message: 'Platforms list is too large' })
  @IsEnum(LeadPlatform, {
    each: true,
    message: 'Each platform must be META, GOOGLE or TIKTOK',
  })
  platforms?: LeadPlatform[];

  @ApiProperty({
    example: 'Looking for enterprise onboarding',
    required: false,
  })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Notes must be a string' })
  @MaxLength(2000, { message: 'Notes must have at most 2000 characters' })
  notes?: string;

  @ApiProperty({ example: 'ENTERPRISE' })
  @SanitizeText()
  @IsString({ message: 'Desired plan must be a string and is required' })
  @MinLength(2, { message: 'Desired plan must have at least 2 characters' })
  @MaxLength(60, { message: 'Desired plan must have at most 60 characters' })
  desiredPlan: string;

  @ApiProperty({ example: 'pricing_page', required: false })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Source must be a string' })
  @MaxLength(120, { message: 'Source must have at most 120 characters' })
  source?: string;
}

export class CreateSalesLeadOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'NEW' })
  status: string;
}
