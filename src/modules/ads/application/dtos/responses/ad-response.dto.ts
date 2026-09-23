import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MoneyViewDto } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * Os read models de §7.1 **descritos em OpenAPI**.
 *
 * Espelham [ad-views.ts](../../../domain/read-models/ad-views.ts), que continua
 * sendo a fonte de verdade: estes DTOs não são instanciados por handler nenhum
 * — o repositório devolve o `type` do domínio e o interceptor o envelopa. Eles
 * existem para que `/docs-json` tenha shape, e a divergência entre os dois é
 * cobrada por `swagger-response-coverage.spec.ts`.
 */

const AD_STATUS = [
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'DELETED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'UNKNOWN',
];

export class EntityRefDto {
  @ApiProperty({ example: 'b3f1…' })
  id!: string;

  @ApiProperty({ example: 'Topo de funil — vídeo 15s' })
  name!: string;
}

export class CreativeRefDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'VIDEO' })
  format!: string | null;
}

/**
 * A referência ao anúncio embutida em waste, recomendações, ações e alertas
 * (§7.5).
 *
 * **Os dois estados viajam juntos, e é a diferença entre eles que informa.** Com
 * um campo só a tela não consegue dizer "pausando…" em vez de "pausado", e o
 * usuário conclui que a ação falhou quando ela está apenas a caminho.
 */
export class AdRefDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    description:
      'A identidade que atravessa recriações (§3.6). Trocar a copy cria um ' +
      'anúncio novo na plataforma e preserva a linhagem — é por ela que a ' +
      'série de métricas não se parte.',
  })
  lineageId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ description: 'O id do anúncio na plataforma.' })
  externalAdId!: string;

  @ApiProperty({
    enum: ['AD', 'ASSET_GROUP'],
    description:
      'O que a plataforma entrega como unidade. `ASSET_GROUP` é o grupo de ' +
      'recursos do Performance Max: pende direto da campanha, sem conjunto, e ' +
      'o criativo dele é o pacote de recursos que o Google combina sozinho.',
  })
  unitKind!: string;

  @ApiProperty({ enum: AD_STATUS, description: 'O que a plataforma reporta.' })
  observedStatus!: string;

  @ApiProperty({
    enum: AD_STATUS,
    nullable: true,
    description:
      'O que pedimos, enquanto a plataforma não confirma. `null` quando não ' +
      'há intenção pendente.',
  })
  desiredStatus!: string | null;

  @ApiProperty({
    enum: ['IN_SYNC', 'PENDING_WRITE', 'DRIFTED', 'UNREACHABLE', 'STALE'],
  })
  syncState!: string;

  @ApiProperty({ type: EntityRefDto })
  campaign!: EntityRefDto;

  @ApiProperty({ type: EntityRefDto, nullable: true })
  adSet!: EntityRefDto | null;

  @ApiProperty({ type: CreativeRefDto, nullable: true })
  creative!: CreativeRefDto | null;
}

/**
 * Score, confiança e cobertura **sempre juntos** (D11).
 *
 * Um score de 38 sem a confiança ao lado convida a decisão que a confiança
 * desaconselha, e a cobertura é o que explica por que a confiança caiu numa
 * plataforma que não entrega metade dos sinais.
 */
export class AdScoreSummaryDto {
  @ApiProperty({ type: Number, nullable: true, example: 41 })
  value!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 0.72 })
  confidence!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.85,
    description:
      '`coverageRatio` — relativo ao teto da plataforma, nunca absoluto. Um ' +
      'anúncio de Search nunca terá frequência nem feedback negativo, e um ' +
      'piso absoluto o tiraria da tela principal.',
  })
  coverage!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: -6 })
  delta7d!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  asOf!: string | null;
}

/**
 * As duas grandezas de §10.1, **nunca uma**.
 *
 * `openAmount` é dinheiro que já foi; `avoidableDaily` é o que dá para
 * interromper hoje — e é o segundo que ordena a tela.
 */
export class AdWasteSummaryDto {
  @ApiProperty({ example: 3 })
  openCount!: number;

  @ApiProperty({
    type: MoneyViewDto,
    nullable: true,
    description: 'O máximo entre os itens abertos — a única parcela somável.',
  })
  openAmount!: MoneyViewDto | null;

  @ApiProperty({ type: MoneyViewDto, nullable: true })
  avoidableDaily!: MoneyViewDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      '`null` significa que o detector nunca visitou este anúncio — o que é ' +
      'diferente de não haver desperdício.',
  })
  asOf!: string | null;
}

/** Uma linha da tela principal (`GET /ads`). */
export class AdListItemDto extends AdRefDto {
  @ApiProperty({
    enum: ['IMMATURE', 'SETTLING', 'MATURE'],
    nullable: true,
    description:
      '§8.9 — dado ainda em re-declaração pela plataforma. Detector ' +
      'destrutivo não dispara abaixo de `MATURE`.',
  })
  dataMaturity!: string | null;

  @ApiProperty({ type: AdScoreSummaryDto })
  score!: AdScoreSummaryDto;

  @ApiProperty({ type: AdWasteSummaryDto })
  waste!: AdWasteSummaryDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;
}

export class AdLineageDto {
  @ApiProperty()
  lineageId!: string;

  @ApiProperty({ type: String, nullable: true })
  originAdId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A execução que produziu este anúncio, quando houve uma.',
  })
  originActionExecutionId!: string | null;

  @ApiProperty({
    example: 2,
    description: 'Quantos anúncios a linhagem já teve, incluindo este.',
  })
  generations!: number;

  @ApiProperty({
    type: [AdRefDto],
    description:
      'Os anúncios da linhagem, do mais antigo ao mais novo. É o que permite a ' +
      'tela mostrar que a série atravessa uma recriação em vez de começar do ' +
      'zero num anúncio "novo" que é o mesmo de sempre.',
  })
  members!: AdRefDto[];
}

/** O agregado inteiro (`GET /ads/{id}`). */
export class AdDetailDto extends AdListItemDto {
  @ApiProperty()
  accountId!: string;

  @ApiProperty()
  organizationId!: string;

  @ApiProperty()
  adAccountId!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'O instante do dado na plataforma. É contra ele que a guarda de ' +
      'recência de §8.4.1 decide se uma divergência é real.',
  })
  observedAsOf!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  desiredStatusSetAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  syncStateAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastStructureSyncAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastMetricsSyncAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  firstSeenAt!: string;

  @ApiProperty({ type: AdLineageDto })
  lineage!: AdLineageDto;
}

/** Um ponto da série diária (`GET /ads/{id}/metrics`). */
export class AdSnapshotDto {
  @ApiProperty()
  adId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-08-01' })
  date!: string;

  @ApiProperty({ type: MoneyViewDto })
  spend!: MoneyViewDto;

  @ApiProperty({ type: MoneyViewDto })
  revenue!: MoneyViewDto;

  @ApiProperty({ example: 128_400 })
  impressions!: number;

  @ApiProperty({ example: 2_140 })
  clicks!: number;

  @ApiProperty({ example: 38 })
  conversions!: number;

  @ApiProperty({ type: Number, nullable: true })
  ctr!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpc!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  cpa!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  roas!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  frequency!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: [
      'ALGO_VERSION_CHANGED',
      'CURRENCY_REBASED',
      'NEW_SIGNAL',
      'PLATFORM_RESTATEMENT',
      'LINEAGE_BREAK',
    ],
    description:
      'O **motivo**, não um booleano: "a série quebrou" sem causa não diz se ' +
      'o usuário deve investigar o anúncio ou se fomos nós que mudamos a régua.',
  })
  seriesDiscontinuity!: string | null;

  @ApiProperty({
    description:
      'M1 — sem taxa de câmbio para a data da linha, `valueBase` é estimativa ' +
      'e a linha fica fora das agregações de inteligência.',
  })
  normalizationPending!: boolean;
}

export class AdHistoryEntryDto {
  @ApiProperty({ type: String, format: 'date-time' })
  at!: string;

  @ApiProperty({
    enum: ['DISCOVERED', 'DERIVED', 'STATUS_CHANGED', 'SYNCED', 'ARCHIVED'],
  })
  kind!: string;

  @ApiProperty({ example: 'Status mudou de ACTIVE para PAUSED.' })
  summary!: string;

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  details!: Record<string, unknown> | null;
}

/**
 * §7.5 — estado por seção, **sempre `200`**.
 *
 * Uma seção sem dado devolve `PENDING`/`UNAVAILABLE`/`EMPTY` com motivo, nunca
 * `404` nem lista vazia. As três dizem coisas diferentes: `PENDING` promete que
 * o dado chega sozinho, `UNAVAILABLE` diz onde ele mora, `EMPTY` afirma que
 * olhamos e não há. Achatá-las faz o usuário concluir "não há problema" quando a
 * verdade é "ainda não analisamos".
 */
export class AdAnalysisSectionDto {
  @ApiProperty({ enum: ['OK', 'PENDING', 'UNAVAILABLE', 'EMPTY'] })
  status!: string;

  @ApiPropertyOptional({
    description:
      'Obrigatório quando o status não é `OK` — o motivo é a informação.',
  })
  reason?: string;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  data?: Record<string, unknown>;
}

export class AdAnalysisDto {
  @ApiProperty({ type: AdRefDto })
  ad!: AdRefDto;

  @ApiProperty({
    type: AdAnalysisSectionDto,
    description: '`OK` com aiScore/confidence/coverage/delta7d/scoredAt.',
  })
  score!: AdAnalysisSectionDto;

  @ApiProperty({
    type: AdAnalysisSectionDto,
    description:
      'Sempre `UNAVAILABLE`: a análise do par (Creative, Ad) é sob demanda, ' +
      'em `POST /ads/{id}/analyze`. `ads` é a base do grafo e não conhece ' +
      '`creative-lab` — a rota que produz a análise é a que a devolve.',
  })
  creativeAnalysis!: AdAnalysisSectionDto;

  @ApiProperty({
    type: AdAnalysisSectionDto,
    description:
      '`OK` com count/incurred/avoidableDaily/asOf; `EMPTY` quando o detector varreu e não achou.',
  })
  openWaste!: AdAnalysisSectionDto;

  @ApiProperty({
    type: AdAnalysisSectionDto,
    description:
      'Sempre `UNAVAILABLE`, apontando `GET /waste/opportunities?adId=`.',
  })
  opportunities!: AdAnalysisSectionDto;

  @ApiProperty({
    type: AdAnalysisSectionDto,
    description:
      'Sempre `UNAVAILABLE`, apontando `GET /ads/{id}/recommendations`.',
  })
  recommendations!: AdAnalysisSectionDto;
}

/**
 * **Não há `AdScorePointDto`, e a ausência é deliberada.**
 *
 * `GET /ads/{id}/scores` responde 422 em todos os casos: `AdScoreReader.
 * seriesByLineage` está implementado e **não tem chamador**, e a rota nunca foi
 * ligada a ele. Declarar um schema de 200 aqui documentaria uma resposta que
 * ninguém recebe — e um cliente gerado a partir dela quebraria no primeiro uso.
 * O DTO entra junto com o use case que servir a rota, não antes.
 */
