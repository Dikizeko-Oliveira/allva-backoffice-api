import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';

export enum SubscriptionPlanType {
  FREE = 'FREE',
  STARTER = 'STARTER',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

export class CreatePlanFeatureInputDto {
  @ApiProperty({
    example: 'creative-analyses',
    required: false,
    description:
      'Slug estável da feature, igual nos quatro planos. Omitido, é derivado ' +
      'de `name` — o que mantém compatível quem já chamava este endpoint.',
  })
  @IsOptional()
  @IsString({ message: 'Feature key must be a string' })
  key?: string;

  @ApiProperty({ example: 'Análises por mês' })
  @IsString({ message: 'Feature name must be a string and is required' })
  name: string;

  @ApiProperty({ example: true })
  @IsBoolean({ message: 'Feature enabled must be a boolean and is required' })
  enabled: boolean;

  @ApiProperty({
    example: '100',
    required: false,
    nullable: true,
    description:
      'O limite como texto de vitrine. Omitido numa feature liga/desliga.',
  })
  @IsOptional()
  @IsString({ message: 'Feature value must be a string' })
  value?: string;

  @ApiProperty({
    example: 'Achados de desperdício e recomendações avulsas do mês.',
    required: false,
    nullable: true,
  })
  @IsOptional()
  @IsString({
    message: 'Feature description must be a string',
  })
  description?: string;

  @ApiProperty({
    example: true,
    required: false,
    default: false,
    description:
      'A linha entra no card do plano. Omitida, vale `false`: o card comporta ' +
      'uma dúzia de linhas, então promover uma feature é a decisão que precisa ' +
      'ser declarada — o contrário faria toda feature nova disputar o espaço ' +
      'do card por inércia.',
  })
  @IsOptional()
  @IsBoolean({ message: 'Feature landingHighlight must be a boolean' })
  landingHighlight?: boolean;
}

export class CreatePlanInputDto {
  @IsString({ message: 'Name must be a string and is required' })
  @ApiProperty({ example: 'Teste Gratuíto' })
  name: string;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({}, { message: 'Trial days must be a number' })
  @Min(0, { message: 'Trial days must be greater than or equal to zero' })
  @ApiProperty({ example: 7, required: false })
  trialDays?: number;

  @Type(() => Number)
  @IsNumber({}, { message: 'Amount must be a number and is required' })
  @Min(0, { message: 'Amount must be greater than or equal to zero' })
  @ApiProperty({ example: 297, description: 'Preço mensal, em reais.' })
  amount: number;

  @Type(() => Number)
  @IsOptional()
  @IsNumber({}, { message: 'Annual amount must be a number' })
  @Min(0, { message: 'Annual amount must be greater than or equal to zero' })
  @ApiProperty({
    example: 2970,
    required: false,
    nullable: true,
    description:
      'Preço anual cheio, em reais. Omitido quando o plano não é vendido no ' +
      'ciclo anual ou o preço é negociado.',
  })
  amountAnnual?: number;

  @ApiProperty({
    enum: SubscriptionPlanType,
    example: SubscriptionPlanType.PRO,
    description: 'Tipo do plano a ser criado',
  })
  @IsEnum(SubscriptionPlanType, {
    message: 'Plan type must be FREE, STARTER, PRO or ENTERPRISE',
  })
  type: SubscriptionPlanType;

  @ApiProperty({
    example: 'price_1RvxxxxxABC123',
    required: false,
    nullable: true,
    description:
      'ID do preço recorrente na Stripe (obrigatório para planos pagos com Stripe)',
  })
  @IsOptional()
  @IsString()
  @Matches(/^price_/, { message: 'stripePriceId must start with "price_"' })
  stripePriceId?: string;

  @ApiProperty({
    example: 'price_1RvxxxxxANNUAL',
    required: false,
    nullable: true,
    description: 'ID do preço recorrente anual na Stripe.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^price_/, {
    message: 'stripePriceIdAnnual must start with "price_"',
  })
  stripePriceIdAnnual?: string;

  @ApiProperty({
    type: [CreatePlanFeatureInputDto],
    required: false,
    example: [
      {
        key: 'creative-analyses',
        name: 'Análises de criativo por mês',
        enabled: true,
        value: '300 por mês',
      },
    ],
  })
  @IsOptional()
  @IsArray({ message: 'Features must be an array' })
  @ValidateNested({ each: true })
  @Type(() => CreatePlanFeatureInputDto)
  features?: CreatePlanFeatureInputDto[];
}

export class CreatePlanOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;
}
