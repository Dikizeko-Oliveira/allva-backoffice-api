import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from 'src/shared/infrastructure/http/pagination/page-query.dto';

export class ListContractDraftsQueryDto extends PageQueryDto {
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  salesLeadId?: string;
}

class SignatureFieldsDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(500)
  draftDocumentKey?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  signatureProvider?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(200)
  envelopeId?: string | null;

  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(100)
  envelopeStatus?: string | null;
}

export class CreateContractDraftInputDto extends SignatureFieldsDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  salesLeadId: string;

  @ApiProperty({
    type: Object,
    description:
      'Os termos no formato de `POST /api/v1/admin/contracts` do `allva-api`. Validados lá, na conversão.',
  })
  @IsObject()
  terms: Record<string, unknown>;
}

export class UpdateContractDraftInputDto extends SignatureFieldsDto {
  @ApiProperty({ required: false, type: Object })
  @IsOptional()
  @IsObject()
  terms?: Record<string, unknown>;

  @ApiProperty({ required: false, example: 'SENT' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  status?: string;
}

export class ContractDraftOutputDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  salesLeadId: string;

  @ApiProperty({ type: Object })
  terms: unknown;

  @ApiProperty({ example: 'DRAFT' })
  status: string;

  @ApiProperty({ nullable: true })
  draftDocumentKey: string | null;

  @ApiProperty({ nullable: true })
  signatureProvider: string | null;

  @ApiProperty({ nullable: true })
  envelopeId: string | null;

  @ApiProperty({ nullable: true })
  envelopeStatus: string | null;

  @ApiProperty({
    nullable: true,
    description: 'O contrato criado no `allva-api` pela conversão.',
  })
  contractId: string | null;

  @ApiProperty()
  createdBy: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class ListContractDraftsOutputDto {
  @ApiProperty({ type: [ContractDraftOutputDto] })
  items: ContractDraftOutputDto[];

  @ApiProperty()
  total: number;

  @ApiProperty()
  page: number;

  @ApiProperty()
  pageSize: number;
}
