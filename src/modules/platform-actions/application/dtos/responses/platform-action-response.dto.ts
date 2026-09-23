import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A superfície de **escrita** descrita em OpenAPI (§13).
 *
 * Duas coisas aqui não são detalhe de serialização e o cliente precisa tratar
 * como contrato:
 *
 * 1. **`POST /ads/{id}/actions` responde `202`, nunca `200`.** A resposta não
 *    afirma que o anúncio está pausado — afirma que a intenção foi aceita e que
 *    a plataforma ainda não respondeu. Uma tela que renderize "pausado" no 202
 *    vai mentir sempre que a Meta recusar meio segundo depois.
 * 2. **`observedStatus` e `desiredStatus` nunca se fundem.** É a diferença
 *    entre eles que permite dizer "pausando…" em vez de "pausado".
 */

export class ActionImpactDto {
  @ApiProperty({
    description: 'O anúncio volta à fase de aprendizado da plataforma.',
  })
  resetsLearning!: boolean;

  @ApiProperty({
    description:
      'Curtidas, comentários e compartilhamentos acumulados se perdem.',
  })
  losesSocialProof!: boolean;

  @ApiProperty({
    description: 'O id do recurso muda — verdadeiro apenas em `RECREATE`.',
  })
  changesResourceId!: boolean;
}

/**
 * Uma das **treze**, disponível ou não.
 *
 * A resposta lista todas sempre, inclusive em plataforma que não suporta a ação:
 * lista curta obriga a tela a inventar o motivo da ausência, e o motivo
 * inventado é sempre "indisponível".
 */
export class AvailableActionDto {
  @ApiProperty({
    example: 'PAUSE_AD',
    enum: [
      'PAUSE_AD',
      'ENABLE_AD',
      'ARCHIVE_AD',
      'DUPLICATE_AD',
      'REPLACE_CREATIVE',
      'REPLACE_COPY',
      'REPLACE_CTA',
      'PAUSE_AD_SET',
      'ENABLE_AD_SET',
      'ADJUST_AD_SET_BUDGET',
      'PAUSE_CAMPAIGN',
      'ENABLE_CAMPAIGN',
      'ADJUST_CAMPAIGN_BUDGET',
    ],
  })
  type!: string;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN'] })
  level!: string;

  @ApiProperty({ description: 'O alvo aceita esta ação agora.' })
  available!: boolean;

  @ApiPropertyOptional({
    enum: [
      'UNSUPPORTED_BY_PLATFORM',
      'ALREADY_IN_TARGET_STATE',
      'TERMINAL_STATE',
      'WRITE_IN_FLIGHT',
      'SYNC_UNRELIABLE',
    ],
    description: 'Presente quando `available: false`. Nunca omitido.',
  })
  reason?: string;

  @ApiPropertyOptional({ description: 'O motivo em texto de tela.' })
  detail?: string;

  @ApiPropertyOptional({
    description:
      'Ação em campanha é exceção justificada por restrição de plataforma, ' +
      'nunca alvo padrão — e sempre com este aviso.',
  })
  scopeWarning?: string;

  @ApiPropertyOptional({
    description:
      '`ARCHIVE_AD` é o caso: a proteção não é a ação estar desligada, é o ' +
      'usuário saber que não há volta **antes** de confirmar.',
  })
  irreversible?: boolean;

  @ApiProperty({
    description: 'A plataforma recria o recurso em vez de editá-lo.',
  })
  requiresRecreate!: boolean;

  @ApiProperty({
    description:
      'A ação cria mídia nova (P1) — as quatro de `REPLACE_*`/`DUPLICATE`.',
  })
  createsEntity!: boolean;

  @ApiProperty({
    type: ActionImpactDto,
    description:
      'Separado de `requiresRecreate` de propósito: na Meta, trocar o criativo ' +
      'mantém o `ad_id` e ainda assim reinicia o aprendizado.',
  })
  impact!: ActionImpactDto;

  @ApiProperty({ enum: ['LOCAL_ONLY', 'PLATFORM'] })
  validationDepth!: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  constraints?: Record<string, unknown>;

  @ApiProperty({
    example: 'actions:execute_sensitive',
    description: 'A permissão que o ator precisa ter — a tela não adivinha.',
  })
  requiredPermission!: string;

  @ApiProperty({
    description:
      '`available` **e** escrita ligada **e** organização não desligada. Uma ' +
      'ação disponível numa instalação em dry-run continua disponível: o que ' +
      'muda é o que acontece ao aplicá-la.',
  })
  executable!: boolean;
}

/**
 * Os três portões, **separados de propósito**.
 *
 * Colapsá-los num booleano faria "esta instalação ainda não escreve" e "sua
 * organização desligou" chegarem à tela como a mesma frase — e só o segundo tem
 * ação do lado do usuário.
 */
export class WriteGatesDto {
  @ApiProperty({
    description: '`PLATFORM_ACTIONS_ENABLED` — decisão da instalação.',
  })
  installationEnabled!: boolean;

  @ApiProperty({
    description:
      '`PLATFORM_ACTIONS_DRY_RUN_ONLY` — permanece `true` por duas semanas em ' +
      'produção após o deploy da escrita (RP5).',
  })
  dryRunOnly!: boolean;

  @ApiProperty({
    description:
      'O kill switch da organização. É o único que o usuário controla.',
  })
  organizationActionsEnabled!: boolean;
}

/**
 * Os portões de escrita **deste anúncio** — os três da instalação mais o da
 * conta, que só existe quando há um anúncio de que falar.
 */
export class AdWriteGatesDto extends WriteGatesDto {
  @ApiProperty({
    description:
      'A conta de anúncios tem credencial. `false` é conta desconectada ' +
      '(P10): o anúncio existe e segue gastando, e só a escrita não sai.',
  })
  accountConnected!: boolean;
}

export class AvailableActionsDto {
  @ApiProperty()
  adId!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ type: AdWriteGatesDto })
  writeGates!: AdWriteGatesDto;

  @ApiProperty({ type: [AvailableActionDto] })
  actions!: AvailableActionDto[];
}

/** A resposta de `POST /ads/{id}/actions` — `202 Accepted`. */
export class ActionAcceptedDto {
  @ApiProperty({
    description:
      'Acompanhe em `GET /ads/actions/executions/{id}` (vem no `Location`).',
  })
  executionId!: string;

  @ApiProperty()
  actionId!: string;

  @ApiProperty({ enum: ['QUEUED'] })
  status!: string;

  @ApiProperty({ description: 'O que a plataforma ainda reporta.' })
  observedStatus!: string;

  @ApiProperty({ type: String, nullable: true, description: 'O que pedimos.' })
  desiredStatus!: string | null;

  @ApiProperty({ type: String, nullable: true })
  scopeWarning!: string | null;
}

/** O acompanhamento de uma execução (`GET /ads/actions/executions/{id}`). */
export class ActionExecutionDto {
  @ApiProperty()
  executionId!: string;

  @ApiProperty()
  actionId!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  adId!: string;

  @ApiProperty()
  actionType!: string;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN'] })
  level!: string;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN'] })
  targetEntityType!: string;

  @ApiProperty()
  targetEntityId!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  parameters!: Record<string, unknown>;

  @ApiProperty({
    enum: [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'REJECTED_BY_PLATFORM',
      'UNSUPPORTED',
      'CANCELLED',
      'PARTIALLY_COMPLETED',
    ],
    description:
      '`PARTIALLY_COMPLETED`: a plataforma criou a entidade e a sequência não ' +
      'terminou — ex.: anúncio duplicado cuja pausa não foi confirmada. Terminal; ' +
      'o id criado vem em `resultPlatformEntityId`.',
  })
  status!: string;

  @ApiProperty()
  attempt!: number;

  @ApiProperty()
  dryRun!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['LOCAL_ONLY', 'PLATFORM'],
  })
  validationDepth!: string | null;

  @ApiProperty({
    description:
      'A chave com que repetir. Opcional no protocolo e obrigatória na ' +
      'prática — ausente, geramos uma e a devolvemos aqui.',
  })
  idempotencyKey!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'Passado disto, o reaper libera o alvo. Expirar é ato, não propriedade.',
  })
  expiresAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'O id que a plataforma devolveu, quando diferente do alvo — é por ele ' +
      'que o ingest seguinte casa a linhagem.',
  })
  resultPlatformEntityId!: string | null;

  @ApiProperty({
    description: 'Em qual degrau da escada de verificação estamos.',
  })
  verificationAttempt!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  verifiedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: ['CONFIRMED', 'DIVERGED', 'INCONCLUSIVE', 'UNVERIFIED_WRITE'],
    description:
      '`UNVERIFIED_WRITE` é terminal: os quatro degraus acabaram sem resposta. ' +
      '`INCONCLUSIVE` significa "pergunto no próximo degrau" e não pode ser o ' +
      'estado final.',
  })
  verificationResult!: string | null;

  @ApiProperty()
  observedStatus!: string;

  @ApiProperty({ type: String, nullable: true })
  desiredStatus!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}

/**
 * O relatório do lote — **uma linha por item, recusa inclusive**.
 *
 * Uma recusa vira linha, não exceção que sobe: abortar devolveria ao usuário o
 * trabalho de descobrir quais itens teriam passado, que é o trabalho que o lote
 * existe para tirar dele.
 */
export class BatchItemResultDto {
  @ApiProperty()
  adId!: string;

  @ApiProperty()
  actionType!: string;

  @ApiProperty({ enum: ['ACCEPTED', 'REJECTED'] })
  outcome!: string;

  @ApiProperty({ type: String, nullable: true })
  executionId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'O `code` da recusa, no mesmo vocabulário do erro tipado.',
  })
  errorCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  errorMessage!: string | null;
}

export class BatchResultDto {
  @ApiProperty({ example: 12 })
  requested!: number;

  @ApiProperty({ example: 10 })
  accepted!: number;

  @ApiProperty({ example: 2 })
  rejected!: number;

  @ApiProperty({ type: [BatchItemResultDto] })
  items!: BatchItemResultDto[];
}

export class WriteConsentDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  integrationId!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  grantedByAccountId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  grantedAt!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Revogação é **soft**: a trilha de quem autorizou o quê não se apaga.',
  })
  revokedAt!: string | null;

  @ApiProperty({ type: String, nullable: true })
  revokedByAccountId!: string | null;

  @ApiProperty({
    type: [String],
    description:
      'Os tipos que este consentimento cobre. Fora da lista, a escrita é recusada.',
  })
  consentedActionTypes!: string[];
}

export class KillSwitchStateDto {
  @ApiProperty()
  organizationId!: string;

  @ApiProperty({
    description:
      'Vale a partir da **próxima** requisição de escrita: a flag é lida do ' +
      'banco a cada pedido, sem cache. Um cache de trinta segundos aqui seria ' +
      'a diferença entre parar e "parar daqui a pouco", numa alavanca cujo ' +
      'único propósito é ser usada quando algo já está errado.',
  })
  actionsEnabled!: boolean;
}

/**
 * A resposta de `GET /ads/actions/consents`.
 *
 * Traz os portões junto porque a tela que gerencia consentimento é a mesma que
 * precisa saber se a escrita sai — e `organizationActionsEnabled` não tinha
 * outra leitura sem um anúncio na mão.
 */
export class WriteConsentsResponseDto {
  @ApiProperty({
    type: [WriteConsentDto],
    description: 'Inclui os revogados — a trilha não se apaga.',
  })
  consents!: WriteConsentDto[];

  @ApiProperty({ type: WriteGatesDto })
  writeGates!: WriteGatesDto;
}
