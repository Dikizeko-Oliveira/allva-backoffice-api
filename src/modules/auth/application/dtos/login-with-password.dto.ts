import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  SESSION_AUDIENCES,
  type SessionAudience,
} from 'src/modules/auth/domain/session-audience';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class LoginWithPasswordInputDto {
  @IsEmail({}, { message: 'Email is invalid' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  @ApiProperty({ example: 'dolores.madrigal@disney.com' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @MaxLength(255)
  @ApiProperty({ example: 'MinhaSenhaSuper5egur@123' })
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(45) // IPv6 safe
  @ApiPropertyOptional({
    example: '189.54.233.10',
    description: 'Client IP address',
  })
  ipAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  @ApiPropertyOptional({
    example:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
    description: 'Client user agent',
  })
  userAgent?: string;

  @IsOptional()
  @IsIn(SESSION_AUDIENCES, {
    message: `audience must be one of: ${SESSION_AUDIENCES.join(', ')}`,
  })
  @ApiPropertyOptional({
    enum: SESSION_AUDIENCES,
    example: 'app',
    description:
      'Front que pede a sessão. `app` recusa conta de plataforma ' +
      '(`PLATFORM_ACCOUNT_NOT_CUSTOMER`); `backoffice` recusa conta de cliente ' +
      '(`BACKOFFICE_ACCESS_DENIED`). Ambos com 403 e antes de criar a sessão. ' +
      'Ausente, não há checagem.',
  })
  audience?: SessionAudience;
}

export class LoginWithPasswordOutputDto {
  @ApiProperty({
    description: 'Short-lived JWT access token',
  })
  accessToken: string;

  @ApiProperty({
    description: 'Long-lived refresh token',
  })
  refreshToken: string;
}
