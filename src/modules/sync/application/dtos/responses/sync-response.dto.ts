import { ApiProperty } from '@nestjs/swagger';

/**
 * A superfície de sincronização descrita em OpenAPI (§8).
 *
 * As três rotas aqui existem para tornar **visível** o que o sync faz sozinho.
 * Nenhuma delas origina mídia (P1): `sync-batch` pede atualização, `quarantine`
 * mostra o que não coube no domínio e `rebind` religa credencial preservando
 * identidade.
 */

export class SyncBatchAcceptedDto {
  @ApiProperty({
    example: 8,
    description:
      'Quantos anúncios entraram na fila. Menor que o pedido quando o ' +
      'debounce de 60 s descartou ids atualizados há pouco — o produto não ' +
      'gasta a cota que protege as escritas para responder a um clique repetido.',
  })
  accepted!: number;
}

export class QuarantineItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  adAccountId!: string;

  @ApiProperty()
  externalAdId!: string;

  @ApiProperty({
    example: 'CAMPAIGN_NOT_RESOLVED',
    description: 'O que o domínio não conseguiu absorver.',
  })
  reason!: string;

  @ApiProperty({
    example: 4,
    description:
      'Todo ingest tenta re-resolver antes de processar. `attempts` alto é ' +
      'dívida real de integração, não fila de espera.',
  })
  attempts!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  firstSeenAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'O `meta.asOf` da rota é o maior destes, não o instante da resposta: ' +
      'sem isso uma quarentena parada há três dias pareceria recém-detectada.',
  })
  lastSeenAt!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  payload!: Record<string, unknown>;
}

export class RebindResultDto {
  @ApiProperty()
  integrationId!: string;

  @ApiProperty({
    example: 2,
    description:
      'Contas religadas por `(organização, plataforma, id externo)` — nunca ' +
      'por integração. É o que preserva `ads.id`, `lineage_id` e contagens (P10).',
  })
  reboundAdAccounts!: number;

  @ApiProperty({
    example: 1,
    description: 'Contas novas, que entram com ingest completo.',
  })
  newAdAccounts!: number;

  @ApiProperty({
    type: [String],
    description:
      'Contas que a credencial nova não alcança. Declarado, não escondido: ' +
      'nada foi arquivado, nenhum desperdício foi resolvido e nenhuma ' +
      'recomendação expirou por causa disto.',
  })
  unreachableAdAccounts!: string[];
}
