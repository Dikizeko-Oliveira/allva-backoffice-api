import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

export class VerifyEmailInputDto {
  @ApiProperty({
    description: 'Email da conta que esta sendo confirmada',
    example: 'usuario@empresa.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: 'Codigo de 6 digitos recebido por email',
    example: '048213',
  })
  @IsString()
  @IsNotEmpty()
  // Exatamente seis digitos: sem isto, um payload com espacos ou tracos
  // gastaria uma tentativa do teto por algo que nunca poderia dar certo.
  @Matches(/^\d{6}$/, { message: 'code must be a 6-digit numeric code' })
  code: string;
}

export class VerifyEmailOutputDto {
  @ApiProperty({ example: 'uuid-account-id' })
  accountId: string;

  @ApiProperty({ example: true })
  emailVerified: true;

  @ApiProperty({
    description:
      'Sessao ja autenticada. O codigo prova a posse da caixa de entrada, ' +
      'entao o cadastro segue direto para a assinatura sem uma segunda ida ao ' +
      '/login — que, alias, seria recusada com 403 ate este momento.',
  })
  accessToken: string;

  @ApiProperty()
  refreshToken: string;
}

export class ResendEmailVerificationInputDto {
  @ApiProperty({
    description: 'Email da conta que deseja reenviar a confirmacao',
    example: 'usuario@empresa.com',
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;
}
