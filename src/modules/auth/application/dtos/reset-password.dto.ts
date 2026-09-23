import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class ResetPasswordInputDto {
  @IsString({ message: 'Token is required' })
  @ApiProperty({ example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6' })
  token: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters long' })
  @ApiProperty({ example: 'NovaSenhaSuper5egur@123' })
  newPassword: string;
}
