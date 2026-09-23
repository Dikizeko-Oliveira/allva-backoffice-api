import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class LoginWithFacebookInputDto {
  @IsString({ message: 'Facebook access token is required' })
  @ApiProperty({
    description: 'Facebook access token issued to the frontend application',
    example: 'EAABsbCS1iHgBO...',
  })
  accessToken: string;

  @IsOptional()
  @IsString()
  @MaxLength(45)
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

  /**
   * O plano escolhido na vitrine antes de clicar em "Facebook". Só é lido
   * quando esta chamada **cria** a conta — quem já tem conta entra sem trocar
   * de plano. Mesmo contrato de `CreateAccountWithPasswordInputDto.selectedPlanId`.
   */
  @IsOptional()
  @IsUUID(undefined, { message: 'selectedPlanId must be a valid plan id' })
  @ApiPropertyOptional({ example: 'uuid-plan-id' })
  selectedPlanId?: string;
}
