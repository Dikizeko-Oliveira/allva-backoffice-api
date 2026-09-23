import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNumber, IsOptional, Min, ValidateIf } from 'class-validator';

/**
 * `null` **apaga** o teto negociado e devolve a linha ao plano; omitir o campo
 * o deixa como está.
 *
 * A distinção é o ponto do endpoint: sem ela, corrigir só o número de contas
 * exigiria reenviar os outros três, e quem esquecesse um apagaria um teto
 * contratado sem perceber.
 */
function negotiated(label: string, example: number) {
  return {
    example,
    required: false,
    nullable: true,
    description:
      `${label} Envie \`null\` para remover o teto negociado e voltar ao do ` +
      'plano; omita o campo para não alterá-lo.',
  };
}

export class UpdateOrganizationQuotaInputDto {
  @ApiProperty(negotiated('Contas de anúncios conectadas.', 120))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxAdAccounts must be an integer' })
  @Min(1, { message: 'maxAdAccounts must be at least 1' })
  maxAdAccounts?: number | null;

  @ApiProperty(negotiated('Anúncios que entram na análise da noite.', 40000))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxMonitoredAds must be an integer' })
  @Min(1, { message: 'maxMonitoredAds must be at least 1' })
  maxMonitoredAds?: number | null;

  @ApiProperty(
    negotiated('Assentos: membros ativos mais convites pendentes.', 80),
  )
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxSeats must be an integer' })
  @Min(1, { message: 'maxSeats must be at least 1' })
  maxSeats?: number | null;

  @ApiProperty(negotiated('Organizações que o dono pode possuir.', 10))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxOrganizations must be an integer' })
  @Min(1, { message: 'maxOrganizations must be at least 1' })
  maxOrganizations?: number | null;

  /**
   * **Não é campo novo no banco — é o campo que nunca teve caminho.**
   *
   * `max_copy_generations_monthly` existe desde a entrega da geração de copy, e
   * `PlanEntitlementService` já a lia. Faltava aqui, e a consequência é que o
   * "sob medida" do Enterprise nesta linha era inalcançável: o contrato podia
   * dizer 800, e a guarda continuava cortando no piso publicado de 300.
   */
  @ApiProperty(negotiated('Gerações de copy por mês.', 800))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxCopyGenerationsMonthly must be an integer' })
  @Min(1, { message: 'maxCopyGenerationsMonthly must be at least 1' })
  maxCopyGenerationsMonthly?: number | null;

  @ApiProperty(negotiated('Análises de criativo por mês.', 5000))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsInt({ message: 'maxCreativeAnalysesMonthly must be an integer' })
  @Min(1, { message: 'maxCreativeAnalysesMonthly must be at least 1' })
  maxCreativeAnalysesMonthly?: number | null;

  /**
   * O teto **diário** de gasto com IA, em moeda-base — a única linha desta lista
   * que não conta unidades, e sim dinheiro.
   *
   * Está aqui, e não na rota de configuração da organização, porque move
   * dinheiro e contorna o plano: `ManageOrganizationAdsSettingsUseCase` é do
   * dono da organização e o próprio documenta que só governa o que a operação
   * dele considera recente. Dar-lhe o próprio teto de gasto seria deixar o
   * cliente escolher quanto a Allva paga por ele.
   *
   * `null` remove o teto e é o que um contrato ainda não precificado precisa —
   * sem ele, a alternativa seria inventar um número no lugar do comercial. A
   * organização sem contrato de escala herda o default de 50 do schema.
   */
  @ApiProperty(negotiated('Teto diário de gasto com IA, em moeda-base.', 200))
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @Type(() => Number)
  @IsNumber({}, { message: 'llmDailyBudgetBase must be a number' })
  @Min(0, { message: 'llmDailyBudgetBase must be at least 0' })
  llmDailyBudgetBase?: number | null;
}

export class OrganizationQuotaOutputDto {
  @ApiProperty({ example: 'uuid' })
  organizationId: string;

  @ApiProperty({
    example: 120,
    nullable: true,
    description:
      'Nulo = herda o teto do plano. **Nunca** significa "ilimitado" — o ' +
      'Enterprise deixou de ter ilimitado, e todo contrato nomeia um número.',
  })
  maxAdAccounts: number | null;

  @ApiProperty({ example: 40000, nullable: true })
  maxMonitoredAds: number | null;

  @ApiProperty({ example: 80, nullable: true })
  maxSeats: number | null;

  @ApiProperty({ example: 10, nullable: true })
  maxOrganizations: number | null;

  @ApiProperty({ example: 800, nullable: true })
  maxCopyGenerationsMonthly: number | null;

  @ApiProperty({ example: 5000, nullable: true })
  maxCreativeAnalysesMonthly: number | null;

  @ApiProperty({
    example: 50,
    nullable: true,
    description:
      'Teto diário de gasto com IA, em moeda-base. Nulo é **sem teto** — o ' +
      'estado de toda organização antes de a coluna ganhar default.',
  })
  llmDailyBudgetBase: number | null;
}
