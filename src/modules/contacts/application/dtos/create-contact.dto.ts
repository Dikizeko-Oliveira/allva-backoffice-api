import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  SanitizeEmail,
  SanitizeMultiline,
  SanitizeText,
} from '../validators/sanitize.transform';

export class CreateContactInputDto {
  @ApiProperty({ example: 'Jane Doe' })
  @SanitizeText()
  @IsString({ message: 'Name must be a string and is required' })
  @MinLength(2, { message: 'Name must have at least 2 characters' })
  @MaxLength(150, { message: 'Name must have at most 150 characters' })
  name: string;

  @ApiProperty({ example: 'jane@example.com' })
  @SanitizeEmail()
  @IsEmail({}, { message: 'Email must be a valid email and is required' })
  @MaxLength(320, { message: 'Email must have at most 320 characters' })
  email: string;

  @ApiProperty({ example: 'Question about pricing' })
  @SanitizeText()
  @IsString({ message: 'Subject must be a string and is required' })
  @MinLength(2, { message: 'Subject must have at least 2 characters' })
  @MaxLength(200, { message: 'Subject must have at most 200 characters' })
  subject: string;

  @ApiProperty({ example: 'I would like to know more about your plans.' })
  @SanitizeMultiline()
  @IsString({ message: 'Message must be a string and is required' })
  @MinLength(2, { message: 'Message must have at least 2 characters' })
  @MaxLength(5000, { message: 'Message must have at most 5000 characters' })
  message: string;

  @ApiProperty({ example: 'Acme Inc', required: false })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Company must be a string' })
  @MaxLength(200, { message: 'Company must have at most 200 characters' })
  company?: string;

  @ApiProperty({ example: 'contact_page', required: false })
  @IsOptional()
  @SanitizeText()
  @IsString({ message: 'Source must be a string' })
  @MaxLength(120, { message: 'Source must have at most 120 characters' })
  source?: string;
}

export class CreateContactOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'NEW' })
  status: string;
}
