import { ApiProperty } from '@nestjs/swagger';

/** Um asset de texto do anúncio (título ou descrição), na posição da plataforma. */
const COPY_ASSET_SCHEMA = {
  type: 'object',
  properties: {
    index: { type: 'number', example: 0 },
    text: { type: 'string', example: 'Aumente suas vendas' },
    pinnedField: { type: 'string', nullable: true, example: 'HEADLINE_1' },
    performanceLabel: {
      type: 'string',
      nullable: true,
      example: 'LOW',
      description:
        'A classificação que a plataforma dá ao recurso (`BEST`, `GOOD`, ' +
        '`LOW`, `LEARNING`, `PENDING`) — hoje só no grupo de recursos do ' +
        'Performance Max. `null` onde não há classificação.',
    },
  },
} as const;

type CopyAssetDto = {
  index: number;
  text: string;
  pinnedField: string | null;
  performanceLabel: string | null;
};

/**
 * As listas de **contexto** — campanha, conjunto e criativo (§7.4).
 *
 * Contexto **situa, não diagnostica**, e a ausência é o contrato: nenhum número
 * de desempenho mora aqui. O mesmo criativo em cinco anúncios tem cinco
 * desempenhos, e uma média por criativo descreveria um anúncio que não existe
 * (§3.4). Quem quer diagnóstico usa `POST /ads/{id}/analyze`, que responde sobre
 * o par `(Creative, Ad)`.
 *
 * **`activeAdCount`/`adCount` são a única contagem**, e são de situação: dizem
 * onde clicar em seguida, não se algo vai bem.
 */

export class CampaignContextDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  externalCampaignId!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true, example: 'ACTIVE' })
  status!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'CONVERSIONS' })
  objective!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Na moeda da conta (`currency`), não na moeda-base.',
  })
  dailyBudget!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lifetimeBudget!: number | null;

  @ApiProperty({ example: 'BRL' })
  currency!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({
    example: 12,
    description: 'Anúncios vivos. Situa, não diagnostica.',
  })
  activeAdCount!: number;
}

export class AdSetContextDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  campaignId!: string;

  @ApiProperty()
  externalAdSetId!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  status!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'OFFSITE_CONVERSIONS' })
  optimizationGoal!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'IMPRESSIONS' })
  billingEvent!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'No Google não existe orçamento de conjunto (`budgetLevels: ["CAMPAIGN"]`) ' +
      '— o campo vem `null` por limitação da plataforma, não por falta de sync.',
  })
  dailyBudget!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  lifetimeBudget!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ example: 4 })
  activeAdCount!: number;
}

export class CreativeContextDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  externalCreativeId!: string;

  @ApiProperty({ enum: ['META', 'GOOGLE', 'TIKTOK'] })
  platform!: string;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'VIDEO' })
  format!: string | null;

  @ApiProperty({ type: String, nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Reconhece o mesmo conteúdo entre contas — é o que `OVERLAPPING_DELIVERY` ' +
      'usa. Não é linhagem.',
  })
  contentHash!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  durationMs!: number | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  lastSyncedAt!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: { type: 'string', nullable: true },
      body: { type: 'string', nullable: true },
      callToAction: { type: 'string', nullable: true },
      landingPageUrl: { type: 'string', nullable: true },
      assets: {
        type: 'object',
        nullable: true,
        properties: {
          headlines: { type: 'array', items: COPY_ASSET_SCHEMA },
          descriptions: { type: 'array', items: COPY_ASSET_SCHEMA },
          longHeadlines: { type: 'array', items: COPY_ASSET_SCHEMA },
        },
      },
    },
    description:
      '**O texto que está no ar.** Contexto, como o resto deste recurso: ' +
      'descreve a peça, não deriva número dela. É o que permite à tela mostrar ' +
      'o "antes e depois" de uma variação de copy e partir do texto existente ' +
      'para melhorá-lo — as duas coisas eram impossíveis enquanto os campos ' +
      'ficavam só no banco.\n\n' +
      '`callToAction` na Meta e no TikTok é **valor de enum**, não frase: ' +
      '`LEARN_MORE`, `SHOP_NOW`. No Google Search o campo não existe e vem ' +
      '`null`.\n\n' +
      '`assets` lista **todos** os títulos e descrições onde a plataforma ' +
      'trabalha com assets (anúncio de busca do Google) — `headline` e `body` ' +
      'guardam só o primeiro de cada. É de onde a tela oferece qual asset ' +
      'substituir em `REPLACE_COPY`. `null` na Meta e no TikTok.\n\n' +
      'No grupo de recursos do Performance Max, `assets` traz também os ' +
      'títulos longos e a classificação do Google por recurso ' +
      '(`performanceLabel`) — a leitura da plataforma, não um número da Allva.',
  })
  copy!: {
    headline: string | null;
    body: string | null;
    callToAction: string | null;
    landingPageUrl: string | null;
    assets: {
      headlines: CopyAssetDto[];
      descriptions: CopyAssetDto[];
      longHeadlines: CopyAssetDto[];
    } | null;
  };

  @ApiProperty({
    example: 3,
    description: 'Em quantos anúncios vivos ele roda.',
  })
  adCount!: number;
}
