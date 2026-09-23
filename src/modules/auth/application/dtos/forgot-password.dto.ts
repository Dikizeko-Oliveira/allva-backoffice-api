import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail } from 'class-validator';

export class ForgotPasswordInputDto {
  @IsEmail({}, { message: 'Email is invalid' })
  @Transform(({ value }) => value?.trim().toLowerCase())
  @ApiProperty({ example: 'dolores.madrigal@disney.com' })
  email: string;
}
