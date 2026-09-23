import { ApiProperty } from '@nestjs/swagger';

class PlanFeatureDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'creative-analyses',
    description:
      'Slug estável, igual nos quatro planos. Agrupe por ele para montar a ' +
      'tabela comparativa da landing.',
  })
  key: string;

  @ApiProperty({ example: 'Análises por mês' })
  name: string;

  @ApiProperty({
    example: true,
    description:
      'Numa feature liga/desliga, é o que a landing marca com ✓ ou —. Numa ' +
      'feature com limite, é sempre `true` e o número está em `value`.',
  })
  enabled: boolean;

  @ApiProperty({
    example: '100',
    nullable: true,
    description:
      'O limite como texto de vitrine. Nulo numa feature liga/desliga.',
  })
  value: string | null;

  @ApiProperty({
    example: 'Achados de desperdício e recomendações avulsas do mês.',
    nullable: true,
  })
  description: string | null;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({
    example: true,
    description:
      'A linha entra no **card** do plano. Use `features.filter(f => ' +
      'f.landingHighlight)` para montar o card — são nove linhas, já em ' +
      '`sortOrder`, e iguais nos três planos para os cards se lerem lado a ' +
      'lado. A tabela comparativa ignora este campo e renderiza o catálogo ' +
      'inteiro, agrupado por `section`. Não confunda com `enabled`, que ' +
      'responde "o plano inclui?".',
  })
  landingHighlight: boolean;

  @ApiProperty({
    example: 'Cobertura',
    enum: [
      'Cobertura',
      'Inteligência',
      'Ação na plataforma',
      'Operação',
      'Governança',
    ],
    description:
      'Seção da tabela comparativa. Derivada da faixa de `sortOrder`, então ' +
      'agrupar por ela preservando a ordem de `sortOrder` reproduz a matriz do ' +
      'catálogo sem o front precisar conhecer as faixas.',
  })
  section: string;

  @ApiProperty({ example: '2026-04-19T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-04-19T00:00:00.000Z' })
  updatedAt: Date;
}

export class ListPlansItemOutputDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Profissional' })
  name: string;

  @ApiProperty({ example: 297, description: 'Preço mensal, em reais.' })
  amount: number;

  @ApiProperty({
    example: 2970,
    nullable: true,
    description:
      'Preço anual cheio, em reais. Nulo quando o plano não é vendido no ' +
      'ciclo anual (FREE) ou o preço é negociado (ENTERPRISE).',
  })
  amountAnnual: number | null;

  @ApiProperty({ example: 'PRO' })
  type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';

  @ApiProperty({
    example: 14,
    nullable: true,
    description:
      'Janela do teste gratuito. Preenchido apenas no FREE, que **é** o ' +
      'teste: fechada a janela, a conta precisa contratar um plano pago.',
  })
  trialDays: number | null;

  @ApiProperty({
    example: false,
    description:
      'O plano é fechado por proposta, não por cartão. Quando `true`, a ' +
      'vitrine mostra "Sob consulta" e leva para o comercial: `amount` é o ' +
      'piso que a landing usa em "a partir de", nunca um preço a cobrar — e ' +
      'as rotas de assinatura, troca de plano e checkout recusam o plano com ' +
      '`PLAN_REQUIRES_SALES_CONTACT`.',
  })
  contactSalesOnly: boolean;

  @ApiProperty({ example: '2026-04-19T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ type: [PlanFeatureDto] })
  features: PlanFeatureDto[];
}
