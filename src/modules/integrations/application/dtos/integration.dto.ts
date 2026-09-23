import { ApiProperty } from '@nestjs/swagger';

export class AdAccountDto {
  @ApiProperty({ example: 'uuid-ad-account-id' })
  id!: string;

  @ApiProperty({ example: 'act_123456789' })
  externalAccountId!: string;

  @ApiProperty({ example: 'Conta Principal' })
  name!: string;

  @ApiProperty({ example: 'meta' })
  platform!: 'META' | 'GOOGLE' | 'TIKTOK';

  @ApiProperty({ example: 'BRL' })
  currency!: string;

  @ApiProperty({ example: 'America/Sao_Paulo' })
  timezone!: string;

  @ApiProperty({
    example: true,
    description:
      'Vinculada e não congelada. É o que o teto do plano conta e o que o ' +
      'sync sincroniza.',
  })
  isActive!: boolean;

  @ApiProperty({
    nullable: true,
    example: '2026-09-01T00:00:00.000Z',
    description:
      'Instante do congelamento por limite de plano. **Data futura é ' +
      'agendamento**: o downgrade só vale no fim do período pago, e até lá a ' +
      'conta continua ativa. Nulo quando não há congelamento.',
  })
  frozenAt!: Date | null;

  /**
   * D17 — a saúde de sincronização da conta, e a única coisa nesta resposta
   * sobre a qual o usuário às vezes pode agir.
   *
   * `UNREACHABLE` é o veredito do passo 9 de §8.2: o ingest **não conseguiu ver
   * a conta inteira**, então nada foi arquivado e nenhum desperdício foi
   * fechado — mas os números pararam no tempo. É o estado que justifica
   * reconectar a credencial. `DEGRADED` pausa inteligência e mantém ações.
   */
  @ApiProperty({ enum: ['HEALTHY', 'DEGRADED', 'UNREACHABLE'] })
  syncHealth!: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';

  @ApiProperty({
    nullable: true,
    example: 'permissão revogada no escopo ads_read',
  })
  syncHealthReason!: string | null;

  @ApiProperty({ nullable: true })
  unreachableSince!: Date | null;

  /**
   * O instante do último ingest **completo**. É contra ele que "meu número está
   * velho" se responde — `lastSyncAt` sobe mesmo em varredura parcial.
   */
  @ApiProperty({ nullable: true })
  lastSuccessfulFullSyncAt!: Date | null;
}

export class IntegrationDto {
  @ApiProperty({ example: 'uuid-integration-id' })
  id!: string;

  @ApiProperty({ example: 'meta' })
  platform!: 'META' | 'GOOGLE' | 'TIKTOK';

  @ApiProperty({ example: 'CONNECTED' })
  status!: string;

  @ApiProperty({ nullable: true, example: '2026-05-11T03:00:00.000Z' })
  lastSyncAt!: Date | null;

  @ApiProperty({ example: 'IDLE' })
  syncStatus!: string;

  @ApiProperty({ type: [AdAccountDto] })
  accounts!: AdAccountDto[];

  @ApiProperty({ nullable: true, example: null })
  syncError!: string | null;
}

export class ExternalAdAccountDto {
  @ApiProperty({ example: 'act_123456789' })
  externalAccountId!: string;

  @ApiProperty({ example: 'Conta Principal' })
  name!: string;

  @ApiProperty({ example: 'BRL' })
  currency!: string;

  @ApiProperty({ example: 'America/Sao_Paulo' })
  timezone!: string;

  @ApiProperty({ example: 'ACTIVE' })
  status!: string;

  @ApiProperty({
    example: true,
    description: 'Whether this account is currently linked and active in Allva',
  })
  linked!: boolean;

  @ApiProperty({
    example: 'uuid-ad-account-id',
    nullable: true,
    description: 'Internal ad account id, present when linked=true',
  })
  linkedId!: string | null;
}

export class ListExternalAdAccountsResponseDto {
  @ApiProperty({ type: [ExternalAdAccountDto] })
  accounts!: ExternalAdAccountDto[];
}

export class SyncStatusResponseDto {
  @ApiProperty({ example: 'META' })
  platform!: 'META' | 'GOOGLE' | 'TIKTOK';

  @ApiProperty({ example: 'CONNECTED' })
  status!: string;

  @ApiProperty({ example: 'IDLE' })
  syncStatus!: string;

  @ApiProperty({ nullable: true, example: '2026-05-11T03:00:00.000Z' })
  lastSyncAt!: Date | null;

  @ApiProperty({ nullable: true, example: null })
  syncError!: string | null;

  @ApiProperty({ type: [AdAccountDto] })
  accounts!: AdAccountDto[];
}
