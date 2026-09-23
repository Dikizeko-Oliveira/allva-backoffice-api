import { ApiProperty } from '@nestjs/swagger';
import { MoneyViewDto } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * A superfície de desperdício **descrita em OpenAPI** (§10).
 *
 * **`openAmount` não existe mais na API**, e a ausência é o contrato: um número
 * só fazia o produto prometer recuperar dinheiro que já foi. Toda rota devolve
 * o par — `incurred` (o que já saiu, verdadeiro e passado) e `avoidableDaily`
 * (o que dá para interromper hoje) —, e é o segundo que ordena a tela.
 */

export class WasteAdRefDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  lineageId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty()
  externalAdId!: string;

  @ApiProperty()
  observedStatus!: string;

  @ApiProperty({ type: 'object', additionalProperties: true })
  campaign!: { id: string; name: string };

  @ApiProperty({ type: 'object', additionalProperties: true, nullable: true })
  adSet!: { id: string; name: string } | null;
}

export class WasteItemDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: WasteAdRefDto })
  ad!: WasteAdRefDto;

  @ApiProperty({
    example: 'ZERO_CONVERSIONS',
    description: 'Um dos dez detectores das duas famílias.',
  })
  type!: string;

  @ApiProperty({
    enum: ['WASTE', 'OPPORTUNITY'],
    description:
      'As duas famílias. `WASTE` é gasto sem retorno; `OPPORTUNITY` é retorno ' +
      'não capturado — e só a primeira soma em dinheiro desperdiçado.',
  })
  findingKind!: string;

  @ApiProperty({ enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] })
  priority!: string;

  @ApiProperty({ example: 7 })
  windowDays!: number;

  @ApiProperty({
    type: MoneyViewDto,
    description: 'O que já foi gasto na janela. Verdadeiro, e passado.',
  })
  incurred!: MoneyViewDto;

  @ApiProperty({
    type: MoneyViewDto,
    description: 'O acionável: o que deixa de sair a partir de hoje se agir.',
  })
  avoidableDaily!: MoneyViewDto;

  @ApiProperty({ example: '38 dias sem conversão com R$ 4.200 de gasto.' })
  diagnosis!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'A evidência que sustenta o achado (P7). Estrutura por tipo.',
  })
  evidence!: Record<string, unknown>;

  @ApiProperty({
    enum: ['SUFFICIENT', 'PARTIAL', 'INSUFFICIENT', 'MISSING_SCORE'],
    description:
      '`PARTIAL` é evidência real mas degradada — benchmark de conta em vez ' +
      'de conjunto, série curta, componente por proxy. Vale menos que plena, ' +
      'e dizer isso é diferente de silenciar.',
  })
  evidenceSufficiency!: string;

  @ApiProperty({
    enum: ['AD', 'AD_SET', 'CAMPAIGN', 'AD_ACCOUNT'],
    description:
      'Onde o achado incide. Achado relacional não é do anúncio sozinho.',
  })
  scopeLevel!: string;

  @ApiProperty({ enum: ['IMMATURE', 'SETTLING', 'MATURE'], nullable: true })
  dataMaturity!: string | null;

  @ApiProperty({ example: 'detector-2.0.1' })
  detectorVersion!: string;

  @ApiProperty({ example: 'profile-3' })
  detectorProfileVersion!: string;

  @ApiProperty({
    example: 4,
    description:
      'Quantas varreduras seguidas reencontraram a condição. É sinal de P8 — ' +
      'não zere ao mudar de versão de detector sem relatório de replay.',
  })
  occurrences!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  detectedAt!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  lastSeenAt!: string;

  @ApiProperty({
    description:
      'Aberto sem observação válida: o número é velho e a tela precisa dizer isso.',
  })
  staleObservation!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  resolvedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Como fechou: por ação nossa, por mudança de estado na plataforma, por ' +
      'expiração ou por troca de detector. A nuance vive inteira aqui — o ' +
      '`status` só tem OPEN e RESOLVED (DEC-1).',
  })
  resolutionKind!: string | null;
}

export class WasteSummaryDto {
  @ApiProperty({ example: 41 })
  openCount!: number;

  @ApiProperty({ example: 17 })
  affectedAds!: number;

  @ApiProperty({ type: MoneyViewDto, nullable: true })
  incurred!: MoneyViewDto | null;

  @ApiProperty({ type: MoneyViewDto, nullable: true })
  avoidableDaily!: MoneyViewDto | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { CRITICAL: 3, HIGH: 12, MEDIUM: 20, LOW: 6 },
  })
  byPriority!: Record<string, number>;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { ZERO_CONVERSIONS: 8, HIGH_CPA: 5 },
  })
  byType!: Record<string, number>;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  asOf!: string | null;

  @ApiProperty({
    example: 2,
    description:
      'DEC-11 — itens de janela diferente da vigente ficam fora e são contados, ' +
      'em vez de somados como se fossem comparáveis.',
  })
  excludedByWindowMismatch!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    properties: {
      count: { type: 'number', example: 14 },
      oldestSeenAt: {
        type: 'string',
        format: 'date-time',
        nullable: true,
      },
    },
    description:
      'Achados abertos que a varredura não reconfirmou nos últimos 7 dias. ' +
      'Com o rodízio do escopo, um anúncio da cauda volta a cada N noites e o ' +
      'achado dele fica parado no meio-tempo — declarar a parcela é o que ' +
      'mantém o total honesto sem escondê-la.',
  })
  unverified!: { count: number; oldestSeenAt: string | null };
}

export class WasteRollupRowDto {
  @ApiProperty()
  groupId!: string;

  @ApiProperty()
  groupName!: string;

  @ApiProperty()
  affectedAds!: number;

  @ApiProperty({
    description:
      'Pré-agregado por anúncio antes de somar (§16.13). Somar a coluna do ' +
      'lado 1 de um join 1:N multiplicaria o total pelo número de achados.',
  })
  openWasteBase!: number;

  @ApiProperty()
  avoidableDailyBase!: number;

  @ApiProperty()
  criticalItems!: number;
}

/**
 * **Não há `WasteRollupDto` com `rows`/`baseCurrency`.** A rota envelopa a
 * lista direto: `data` é `WasteRollupRowDto[]`, a moeda-base vai em
 * `meta.organization.baseCurrency` e `excludedByWindowMismatch` em
 * `meta.provenance` — que é onde o envelope de §7.0 já os carrega para todas as
 * rotas. Declarar um objeto aqui faria o cliente gerado esperar `data.rows`.
 */

export class WasteByAdRowDto {
  @ApiProperty({ type: WasteAdRefDto })
  ad!: WasteAdRefDto;

  @ApiProperty()
  openCount!: number;

  @ApiProperty({ type: MoneyViewDto })
  incurred!: MoneyViewDto;

  @ApiProperty({ type: MoneyViewDto })
  avoidableDaily!: MoneyViewDto;

  @ApiProperty({ type: [String], example: ['ZERO_CONVERSIONS', 'HIGH_CPA'] })
  types!: string[];

  @ApiProperty({ enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] })
  worstPriority!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  wasteAsOf!: string | null;
}

const EVIDENCE_GAP_CODES = [
  'AWAITING_DAYS',
  'AWAITING_IMPRESSIONS',
  'AWAITING_SPEND',
  'AWAITING_CONVERSIONS',
  'AWAITING_MATURITY',
  'AWAITING_SCORE',
  'OBJECTIVE_UNKNOWN',
  'NO_BENCHMARK',
  'OBJECTIVE_NOT_CONVERSION',
  'CONVERSION_NOT_MEASURABLE',
  'COMPONENT_UNAVAILABLE',
  'AD_LEFT_AD_SET',
] as const;

const EVIDENCE_GAP_NATURES = [
  'AWAITING',
  'STRUCTURAL',
  'NOT_APPLICABLE',
] as const;

export class EvidenceGapDto {
  @ApiProperty({ enum: EVIDENCE_GAP_CODES, example: 'AWAITING_CONVERSIONS' })
  code!: string;

  @ApiProperty({
    enum: EVIDENCE_GAP_NATURES,
    description:
      '`AWAITING`: o tempo resolve e há estimativa. `STRUCTURAL`: depende da ' +
      'conta (menos de 3 anúncios comparáveis). `NOT_APPLICABLE`: o detector não ' +
      'se aplica ao anúncio (ex.: objetivo que não é conversão).',
  })
  nature!: string;

  @ApiProperty({ type: [String], example: ['HIGH_CPA'] })
  detectorTypes!: string[];

  @ApiProperty({ example: '1 de 3 conversões (lead) na janela.' })
  reason!: string;

  @ApiProperty({ type: Number, nullable: true, example: 1 })
  current!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3 })
  required!: number | null;

  @ApiProperty({
    type: String,
    format: 'date',
    nullable: true,
    description:
      'Estimativa pelo ritmo recente do anúncio. `null` quando não há como prever.',
  })
  estimatedReadyOn!: string | null;

  @ApiProperty({
    description:
      '`true` quando, no ritmo atual, a janela nunca junta o mínimo — o dia novo ' +
      'que entra repõe só o dia velho que sai.',
  })
  unreachableAtCurrentPace!: boolean;
}

export class AdOptimizationDto {
  @ApiProperty({
    enum: ['CONVERSION', 'TRAFFIC', 'AWARENESS', 'ENGAGEMENT', 'UNKNOWN'],
  })
  optimizationClass!: string;

  @ApiProperty({ type: String, nullable: true, example: 'LEAD' })
  conversionEvent!: string | null;

  @ApiProperty()
  conversionMeasurable!: boolean;

  @ApiProperty({ enum: ['AD_SET', 'CAMPAIGN', 'NONE'] })
  source!: string;

  @ApiProperty({ example: 'conversão (lead)' })
  label!: string;
}

export class AdEvidenceDto {
  @ApiProperty()
  adId!: string;

  @ApiProperty({ type: AdOptimizationDto })
  optimization!: AdOptimizationDto;

  @ApiProperty({
    description:
      '`false` quando o ciclo de detecção ainda não avaliou o anúncio, ou ele não ' +
      'entrega. Aí `gaps` vazio não significa "tudo julgado".',
  })
  evaluated!: boolean;

  @ApiProperty({ type: [EvidenceGapDto] })
  gaps!: EvidenceGapDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  asOf!: string | null;
}

export class EvidenceGapCountDto {
  @ApiProperty({ enum: EVIDENCE_GAP_CODES })
  code!: string;

  @ApiProperty({ enum: EVIDENCE_GAP_NATURES })
  nature!: string;

  @ApiProperty({ example: 12 })
  ads!: number;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReadyOn!: string | null;

  @ApiProperty({ example: 2 })
  unreachableAds!: number;
}

export class EvidenceSummaryDto {
  @ApiProperty({ example: 48 })
  adsEvaluated!: number;

  @ApiProperty({ example: 19 })
  adsAwaitingEvidence!: number;

  @ApiProperty({ example: 21 })
  adsFullyJudged!: number;

  @ApiProperty({ example: 8 })
  adsOutsideConversionScope!: number;

  @ApiProperty({ type: [EvidenceGapCountDto] })
  byCode!: EvidenceGapCountDto[];

  @ApiProperty({ type: String, format: 'date', nullable: true })
  nextReadyOn!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  asOf!: string | null;
}
