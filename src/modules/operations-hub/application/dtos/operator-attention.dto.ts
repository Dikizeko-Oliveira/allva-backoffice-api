import { ApiProperty } from '@nestjs/swagger';
import {
  ATTENTION_SEVERITIES,
  type AttentionSeverity,
} from 'src/modules/operations-hub/domain/attention-signals';

export class AttentionSignalDto {
  @ApiProperty({ example: 'support.sla_breached' })
  key: string;

  @ApiProperty({
    example: 'support:read',
    description:
      'A permissão que deu acesso ao sinal. A web casa com o item de navegação que exige a mesma permissão para saber em que área o contador cai.',
  })
  permission: string;

  @ApiProperty({ enum: ATTENTION_SEVERITIES, example: 'CRITICAL' })
  severity: AttentionSeverity;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4,
    description:
      '`0` = nada pendente. `null` = a contagem falhou agora; a tela deve dizer "indisponível", não "zero".',
  })
  count: number | null;
}

export class OperatorAttentionOutputDto {
  @ApiProperty({ example: '2026-09-23T12:00:00.000Z' })
  generatedAt: string;

  @ApiProperty({
    type: [AttentionSignalDto],
    description:
      'Só os sinais cuja permissão o operador tem. Ordenados por severidade e, dentro dela, pela ordem do catálogo.',
  })
  signals: AttentionSignalDto[];
}
