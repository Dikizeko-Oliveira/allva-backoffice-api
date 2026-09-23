import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UpdateAccountInputDto {
  @IsOptional()
  @IsString({ message: 'Name must be a string' })
  @ApiProperty({ example: 'Dolores Madrigal', required: false })
  name?: string;

  @IsOptional()
  @IsString({ message: 'CPF must be a string' })
  @ApiProperty({ example: '12345678909', required: false })
  cpf?: string;

  @IsOptional()
  @IsString({ message: 'Phone must be a string' })
  @ApiProperty({ example: '+55 11 99999-9999', required: false })
  phone?: string;

  @IsOptional()
  @IsString({ message: 'Address must be a string' })
  @ApiProperty({ example: 'Rua das Flores', required: false })
  address?: string;

  @IsOptional()
  @IsString({ message: 'Address number must be a string' })
  @ApiProperty({ example: '123', required: false })
  addressNumber?: string;

  @IsOptional()
  @IsString({ message: 'Address complement must be a string' })
  @ApiProperty({ example: 'Apto 45', required: false })
  addressComplement?: string;

  @IsOptional()
  @IsString({ message: 'Address city must be a string' })
  @ApiProperty({ example: 'Sao Paulo', required: false })
  addressCity?: string;

  @IsOptional()
  @IsString({ message: 'Avatar URL must be a string' })
  @ApiProperty({
    example: 'https://cdn.allva.com/avatars/account-01.png',
    required: false,
  })
  avatarUrl?: string;
}
