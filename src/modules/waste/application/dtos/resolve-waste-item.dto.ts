import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  FINDING_TYPES,
  type FindingType,
} from 'src/modules/waste/domain/contracts/finding-catalog';

const MANUAL_RESOLUTIONS = ['RESOLVED_EXTERNALLY', 'DISMISSED'] as const;

/**
 * `PATCH /waste/items/{id}/resolve` (§10.9).
 *
 * Só dois desfechos são manuais, e o conjunto é fechado de propósito:
 * `RESOLVED_BY_RESTATEMENT` e `STALE` são conclusões que o worker tira do dado —
 * deixá-las na mão do usuário permitiria fechar um falso positivo como acerto e
 * contaminaria o dataset de P8 na origem.
 *
 * O motivo é obrigatório. "Resolvido" sem motivo é indistinguível de "cansei de
 * ver isto na lista", e as duas coisas dizem coisas opostas sobre o detector.
 */
export class ResolveWasteItemDto {
  @ApiProperty({ enum: MANUAL_RESOLUTIONS })
  @IsIn(MANUAL_RESOLUTIONS as unknown as string[])
  kind!: (typeof MANUAL_RESOLUTIONS)[number];

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: 'Notas livres para a auditoria.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/**
 * `POST /ads/{id}/resolve` (§10.9, linha "por anúncio").
 *
 * Resolve os achados **abertos** de um anúncio de uma vez. O mesmo conjunto
 * fechado de desfechos do caminho item a item, pela mesma razão: o usuário
 * declara o que observou, e as conclusões que o worker tira do dado
 * (`RESOLVED_BY_RESTATEMENT`, `STALE`) continuam sendo dele.
 *
 * `types` existe porque "resolvi o problema deste anúncio" quase nunca é
 * verdade sobre **todos** os problemas dele: quem trocou o criativo resolveu a
 * fadiga, não o CPA alto. Sem o filtro, a rota convidaria a fechar em lote
 * achados que continuam verdadeiros — e o próximo ciclo os reabriria, com
 * `occurrences` de volta a 1.
 */
export class ResolveAdWasteDto extends ResolveWasteItemDto {
  @ApiPropertyOptional({
    enum: FINDING_TYPES as unknown as string[],
    isArray: true,
    description:
      'Restringe a resolução a estes tipos. Ausente = todos os abertos do anúncio.',
  })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(FINDING_TYPES as unknown as string[], { each: true })
  types?: FindingType[];
}
