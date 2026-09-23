import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ChangePasswordInputDto {
  @ApiProperty({ example: 'SenhaAtual@123' })
  @IsString({ message: 'Current password is required' })
  currentPassword: string;

  @ApiProperty({ example: 'NovaSenha@456' })
  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  newPassword: string;
}

export class ChangePasswordOutputDto {
  success: boolean;
  message: string;
}
