import { ApiProperty } from '@nestjs/swagger';
import { MoneyViewDto } from 'src/shared/infrastructure/http/envelope/api-envelope.swagger';

/**
 * A recomendação como **plano executável**, descrita em OpenAPI (§9).
 *
 * Não é um texto com um botão: `actions[]` é o que de fato será enviado à
 * plataforma se alguém aplicar, com alvo, parâmetros validados por schema e
 * reversibilidade declarada **antes** da confirmação. É o que permite a tela
 * mostrar as consequências em vez de prometê-las.
 */

export class RecommendationAdRefDto {
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

export class RecommendationActionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({
    example: 'PAUSE_AD',
    description:
      'Uma das treze de `AdActionType`. As de campanha (`PAUSE_CAMPAIGN`, ' +
      '`ENABLE_CAMPAIGN`, `ADJUST_CAMPAIGN_BUDGET`) existem aqui — é por elas ' +
      'que se pausa uma campanha, não por um `PATCH /campaigns/{id}`.',
  })
  type!: string;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN'] })
  level!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Validado por schema Zod versionado, com `schemaVersion` no payload.',
  })
  parameters!: Record<string, unknown>;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN'] })
  targetEntityType!: string;

  @ApiProperty()
  targetEntityId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Presente quando a ação atinge além do anúncio — pausar o conjunto para ' +
      'de veicular os irmãos. O aviso vem antes da confirmação, não depois.',
  })
  scopeWarning!: string | null;

  @ApiProperty()
  reversible!: boolean;

  @ApiProperty({
    description:
      'A plataforma recria o recurso em vez de editá-lo em lugar. Trocar a ' +
      'copy reinicia o aprendizado e zera a prova social — e o usuário precisa ' +
      'saber disso antes de confirmar, não depois.',
  })
  requiresRecreate!: boolean;
}

export class RecommendationImpactDto {
  @ApiProperty({ enum: ['SAVINGS', 'EFFICIENCY_GAIN', 'REVENUE_UPLIFT'] })
  type!: string;

  @ApiProperty({ type: MoneyViewDto })
  estimated!: MoneyViewDto;

  @ApiProperty({ example: 14 })
  horizonDays!: number;

  @ApiProperty({ example: 0.65 })
  confidence!: number;

  @ApiProperty({
    type: MoneyViewDto,
    nullable: true,
    description:
      'Vem de `RecommendationOutcome`, a fonte de verdade do medido (B8). ' +
      '`null` enquanto a janela pós não fechou.',
  })
  realized!: MoneyViewDto | null;
}

export class RecommendationDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ type: RecommendationAdRefDto })
  ad!: RecommendationAdRefDto;

  @ApiProperty({ example: 'PAUSE_ZERO_CONVERSION_AD' })
  kind!: string;

  @ApiProperty({
    description:
      'Consultiva: descreve, não executa. **Nunca entra nas métricas de ' +
      'acurácia de P8** — medir uma recomendação que ninguém podia aplicar ' +
      'contaminaria a régua.',
  })
  advisory!: boolean;

  @ApiProperty({ type: String, nullable: true })
  outOfScopeReason!: string | null;

  @ApiProperty()
  title!: string;

  @ApiProperty()
  rationale!: string;

  @ApiProperty({ type: String, nullable: true })
  guidance!: string | null;

  @ApiProperty({ enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] })
  priority!: string;

  @ApiProperty({
    enum: [
      'NEW',
      'ACKNOWLEDGED',
      'APPLYING',
      'APPLIED',
      'FAILED',
      'DISMISSED',
      'EXPIRED',
      'SUPERSEDED',
      'DEFERRED_BY_CONFLICT',
    ],
  })
  status!: string;

  @ApiProperty({ type: String, nullable: true })
  blockedReason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'O conflito é resolvido por **alvo de ação**, não por anúncio: duas ' +
      'escritas opostas na mesma entidade viram "a última vence" se o conflito ' +
      'for medido pelo anúncio.',
  })
  conflictWithId!: string | null;

  @ApiProperty({ type: [RecommendationImpactDto] })
  impacts!: RecommendationImpactDto[];

  @ApiProperty({
    enum: ['SPEND_AVOIDED', 'REVENUE_DELTA', 'SCORE_DELTA', 'CPA_DELTA'],
    description: 'O delta que a medição de P8 vai observar. Um só, por DEC-6.',
  })
  primaryImpactType!: string;

  @ApiProperty({ example: 'BRL' })
  baseCurrency!: string;

  @ApiProperty({
    type: 'array',
    items: { type: 'object', additionalProperties: true },
    description:
      'Os achados que esta recomendação resolve, com o estado de cada um.',
  })
  wasteItems!: Array<{ id: string; type: string; open: boolean }>;

  @ApiProperty({ type: [RecommendationActionDto] })
  actions!: RecommendationActionDto[];

  @ApiProperty({ enum: ['IMMATURE', 'SETTLING', 'MATURE'], nullable: true })
  dataMaturity!: string | null;

  @ApiProperty({ type: 'object', additionalProperties: true })
  evidence!: Record<string, unknown>;

  @ApiProperty({ type: String, format: 'date-time' })
  evidenceAsOf!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'Vencida, aplicar devolve 409 tipado. A premissa é revalidada no apply ' +
      'de qualquer forma — o prazo é o corte barato, não a proteção.',
  })
  expiresAt!: string | null;

  @ApiProperty({ example: 'engine-1.0.0' })
  engineVersion!: string;
}

export class ImpactByTypeDto {
  @ApiProperty({ enum: ['SAVINGS', 'EFFICIENCY_GAIN', 'REVENUE_UPLIFT'] })
  type!: string;

  @ApiProperty({
    description: 'Projeção sobre o que está na tela, esperando decisão.',
  })
  openEstimatedBase!: number;

  @ApiProperty()
  openCount!: number;

  @ApiProperty({
    description:
      'Projeção sobre o que foi **aplicado** — a única régua comparável com o ' +
      'medido. Comparar o realizado de dez aplicações com a estimativa de ' +
      'duzentas abertas produziria uma "taxa de realização" que mede quantas ' +
      'ainda não foram aplicadas.',
  })
  appliedEstimatedBase!: number;

  @ApiProperty()
  appliedCount!: number;

  @ApiProperty({
    description:
      '**`observedDelta`, jamais `causedSavings`.** É medição pré/pós, não ' +
      'atribuição causal, e o nome do campo é onde a distinção sobrevive.',
  })
  observedDeltaBase!: number;

  @ApiProperty()
  measuredCount!: number;

  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { IMPROVED: 7, UNCHANGED: 2, WORSENED: 1 },
    description:
      'A acurácia de P8: quantas melhoraram, pioraram, ficaram iguais.',
  })
  byVerdict!: Record<string, number>;
}

export class ImpactMeasurementDto {
  @ApiProperty({ description: 'Aplicadas cuja janela pós ainda não fechou.' })
  pending!: number;

  @ApiProperty()
  measured!: number;

  @ApiProperty({
    description:
      'Perderam o alvo antes de medir — anúncio arquivado, conta desconectada.',
  })
  abandoned!: number;

  @ApiProperty({
    description: 'Medições com ao menos um confounder detectado.',
  })
  withConfounders!: number;

  @ApiProperty({
    type: [String],
    description:
      'Mais de uma versão significa números de réguas diferentes. Exibir a ' +
      'lista é o que impede alguém de somar duas medidas distintas.',
  })
  versions!: string[];
}

export class ImpactSummaryDto {
  @ApiProperty({ example: 'BRL' })
  baseCurrency!: string;

  @ApiProperty({
    type: [ImpactByTypeDto],
    description: 'Os três tipos, **nunca somados** — unidades diferentes.',
  })
  byType!: ImpactByTypeDto[];

  @ApiProperty({
    description: 'Consultivas excluídas das métricas de acurácia.',
  })
  advisoryExcluded!: number;

  @ApiProperty({
    type: ImpactMeasurementDto,
    description:
      'O estado do ciclo, para a tela não confundir "zero" com "ainda não".',
  })
  measurement!: ImpactMeasurementDto;
}

export class SuppressionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'PAUSE_ZERO_CONVERSION_AD' })
  kind!: string;

  @ApiProperty({ enum: ['AD', 'AD_SET', 'CAMPAIGN', 'ORGANIZATION'] })
  scope!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '`null` quando o escopo é `ORGANIZATION` — não há id a casar.',
  })
  scopeId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: '`null` = permanente.',
  })
  expiresAt!: string | null;

  @ApiProperty()
  reason!: string;

  @ApiProperty()
  createdByAccountId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;
}
