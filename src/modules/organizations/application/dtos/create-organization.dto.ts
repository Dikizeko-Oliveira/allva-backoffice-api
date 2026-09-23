import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class CreateOrganizationInputDto {
  @ApiProperty({ example: 'Allva LTDA' })
  @IsString({ message: 'Name must be a string and is required' })
  name: string;

  @ApiProperty({ example: '12.345.678/0001-99', required: false })
  @IsOptional()
  @IsString({ message: 'CNPJ must be a string' })
  cnpj?: string;

  @ApiProperty({ example: '+55 11 99999-9999', required: false })
  @IsOptional()
  @IsString({ message: 'Phone must be a string' })
  phone?: string;

  @ApiProperty({ example: 'Av. Paulista', required: false })
  @IsOptional()
  @IsString({ message: 'Address must be a string' })
  address?: string;

  @ApiProperty({ example: '1000', required: false })
  @IsOptional()
  @IsString({ message: 'Address number must be a string' })
  addressNumber?: string;

  @ApiProperty({ example: 'Conjunto 120', required: false })
  @IsOptional()
  @IsString({ message: 'Address complement must be a string' })
  addressComplement?: string;

  @ApiProperty({ example: 'Sao Paulo', required: false })
  @IsOptional()
  @IsString({ message: 'Address city must be a string' })
  addressCity?: string;
}

export class CreateOrganizationOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;
}
