import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, IsUUID, MinLength } from 'class-validator';

export class CreateAccountWithPasswordInputDto {
  @IsString({ message: 'Name is required' })
  @ApiProperty({ example: 'Dolores Madrigal' })
  name: string;

  @IsEmail({}, { message: 'Email is invalid' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  @ApiProperty({ example: 'dolores.madrigal@disney.com' })
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @ApiProperty({ example: 'MinhaSenhaSuper5egur@123' })
  password: string;

  /**
   * O plano escolhido na landing, quando a pessoa escolheu um.
   *
   * Ele viajava só como `?next=` na URL do front e morria no primeiro
   * redirecionamento — nada no backend jamais soube que aquele cadastro tinha
   * vindo do card "Profissional". É o que decide se a organização nasce no teste
   * gratuito ou esperando o primeiro pagamento.
   *
   * Opcional de propósito: cadastro direto pelo `/auth/register`, sem passar
   * pela vitrine, continua sendo um cadastro válido — e cai no teste.
   */
  @IsOptional()
  @IsUUID(undefined, { message: 'selectedPlanId must be a valid plan id' })
  @ApiPropertyOptional({ example: 'uuid-plan-id' })
  selectedPlanId?: string;
}

export class CreateAccountWithPasswordOutputDto {
  @ApiProperty({ example: 'uuid-account-id' })
  accountId: string;
}
