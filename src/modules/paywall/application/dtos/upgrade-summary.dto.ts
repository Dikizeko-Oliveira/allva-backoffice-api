import { ApiProperty } from '@nestjs/swagger';

export class UpgradeSummaryMoneyDto {
  @ApiProperty({ example: 4812.35 })
  amount!: number;

  @ApiProperty({ example: 'BRL' })
  currency!: string;
}

export class UpgradeSummaryDto {
  @ApiProperty({
    enum: ['READY', 'NO_DATA'],
    example: 'READY',
    description:
      '`NO_DATA` significa que ainda não há o que mostrar — organização sem ' +
      'integração, sem achado, ou motor desligado nesta instalação. A tela ' +
      'escolhe a cópia por aqui em vez de inferir de números zerados.',
  })
  state!: 'READY' | 'NO_DATA';

  @ApiProperty({
    type: UpgradeSummaryMoneyDto,
    nullable: true,
    description:
      'Desperdício **incorrido** e ainda aberto: dinheiro já gasto nos ' +
      'anúncios que os detectores marcaram. Soma a denormalização de `ads` (o ' +
      'máximo por anúncio), nunca `waste_items` — somar itens somaria entre ' +
      'tipos e contaria o mesmo anúncio duas vezes.',
  })
  wasteFound!: UpgradeSummaryMoneyDto | null;

  @ApiProperty({
    type: UpgradeSummaryMoneyDto,
    nullable: true,
    description:
      'Desperdício **evitável por dia** se os achados abertos forem tratados. ' +
      'É o número que dá urgência à tela: o incorrido é passado e já não se ' +
      'recupera; este é futuro, e é o único dos dois sobre o qual contratar ' +
      'hoje muda alguma coisa. Nunca somar com `wasteFound` — passado ' +
      'incorrido e projeção diária são grandezas diferentes.',
  })
  avoidableDaily!: UpgradeSummaryMoneyDto | null;

  @ApiProperty({
    example: 23,
    description: 'Anúncios distintos com ao menos um achado aberto.',
  })
  affectedAds!: number;

  @ApiProperty({ example: 47, description: 'Achados abertos no recorte.' })
  openFindings!: number;

  @ApiProperty({
    example: 6,
    description: 'Recomendações que a organização chegou a aplicar.',
  })
  actionsApplied!: number;

  @ApiProperty({
    example: 4,
    description:
      'Aplicações cuja janela pós fechou com veredito `IMPROVED`. É contagem ' +
      'de vereditos, **não** afirmação de economia causada (D6): o produto ' +
      'mede pré/pós, não atribui causa.',
  })
  outcomesImproved!: number;

  @ApiProperty({
    example: 5,
    description: 'Aplicações com janela pós já fechada e veredito emitido.',
  })
  outcomesMeasured!: number;

  @ApiProperty({
    example: 14,
    description: 'Janela de análise vigente da organização, em dias.',
  })
  windowDays!: number;

  @ApiProperty({
    example: 4512,
    description:
      'Anúncios sincronizados que ficaram **fora** da análise por causa do ' +
      'teto do plano. Maior que zero significa que os números acima são ' +
      'parciais — e é o argumento de upgrade mais direto que a tela tem.',
  })
  adsExcludedByPlanLimit!: number;

  @ApiProperty({
    example: '2026-08-20T03:12:00.000Z',
    nullable: true,
    description:
      'Instante da leitura que sustenta os números. Nulo quando não há ' +
      'nenhuma detecção registrada.',
  })
  asOf!: string | null;
}
