import { ApiProperty } from '@nestjs/swagger';
import {
  ATTENTION_SEVERITIES,
  ATTENTION_SIGNAL_KEYS,
  type AttentionSeverity,
  type AttentionSignalKey,
} from 'src/modules/operations-hub/domain/attention-signals';
import {
  PLATFORM_PERMISSIONS,
  type PlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';

export class AttentionSignalDto {
  @ApiProperty({
    enum: ATTENTION_SIGNAL_KEYS,
    example: 'support.tickets_unassigned',
  })
  key: AttentionSignalKey;

  @ApiProperty({
    enum: PLATFORM_PERMISSIONS,
    example: 'support:read',
    description:
      'A permissão que deu acesso ao sinal. O backoffice casa com o item de navegação que exige a mesma permissão para saber em que área o contador cai.',
  })
  permission: PlatformPermission;

  @ApiProperty({ enum: ATTENTION_SEVERITIES, example: 'WARNING' })
  severity: AttentionSeverity;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 7,
    description:
      '`0` = nada pendente. `null` = a contagem falhou agora; a tela deve dizer "indisponível", não "zero".',
  })
  count: number | null;
}

export class OperatorAttentionOutputDto {
  @ApiProperty({ example: '2026-09-22T21:04:00.000Z' })
  generatedAt: string;

  @ApiProperty({
    type: [AttentionSignalDto],
    description:
      'Só os sinais cuja permissão o operador tem, inclusive os zerados. Ordenados por severidade e, dentro dela, pela ordem do catálogo.',
  })
  signals: AttentionSignalDto[];
}
