import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Min,
} from 'class-validator';

export enum BillingIntervalDto {
  ANNUAL = 'ANNUAL',
  MONTHLY = 'MONTHLY',
}

export enum PaymentTermsDto {
  UPFRONT = 'UPFRONT',
  NET_15 = 'NET_15',
  NET_30 = 'NET_30',
  NET_60 = 'NET_60',
}

export enum PaymentMethodDto {
  BOLETO = 'BOLETO',
  PIX = 'PIX',
  TRANSFER = 'TRANSFER',
  CARD = 'CARD',
}

export enum SuspensionReasonDto {
  NON_PAYMENT = 'NON_PAYMENT',
  OPERATOR = 'OPERATOR',
}

export class CreateContractInputDto {
  @ApiProperty({ description: 'O lead que originou o negócio.' })
  @IsUUID()
  salesLeadId: string;

  @ApiProperty({ description: 'O plano do catálogo que ancora o entitlement.' })
  @IsUUID()
  planId: string;

  @ApiProperty({ example: '2026-10-01T00:00:00.000Z' })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2027-09-30T23:59:59.000Z' })
  @IsDateString()
  endsAt: string;

  @ApiProperty({ enum: BillingIntervalDto })
  @IsEnum(BillingIntervalDto)
  billingInterval: BillingIntervalDto;

  @ApiProperty({ example: 48000 })
  @IsNumber()
  @Min(0.01, { message: 'Contract amount must be greater than zero' })
  billingAmount: number;

  @ApiPropertyOptional({
    example: 8000,
    description: 'Cobrança única de implantação, quando vendida junto.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  setupFeeAmount?: number;

  @ApiPropertyOptional({ example: 'BRL', default: 'BRL' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ enum: PaymentTermsDto })
  @IsEnum(PaymentTermsDto)
  paymentTerms: PaymentTermsDto;

  @ApiProperty({ enum: PaymentMethodDto })
  @IsEnum(PaymentMethodDto)
  paymentMethod: PaymentMethodDto;

  @ApiPropertyOptional({
    default: true,
    description:
      'Abre o acesso na assinatura, sem esperar a fatura fechar. Falso quando ' +
      'a negociação exigir pré-pagamento.',
  })
  @IsOptional()
  @IsBoolean()
  activateOnSignature?: boolean;

  @ApiPropertyOptional({
    default: 7,
    description:
      'Dias de atraso tolerados antes de a inadimplência fechar o acesso. ' +
      'Negociável por contrato; omitir usa uma semana.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @ApiPropertyOptional({
    description: 'Teto negociado. Omitir ou enviar nulo herda o teto do plano.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdAccounts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMonitoredAds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrganizations?: number;

  /**
   * O teto **diário** de gasto com IA, em moeda-base.
   *
   * Omitir deixa o contrato **sem teto**, e é o certo: o default de R$ 50/dia
   * foi calibrado para o maior plano de autoatendimento, e cortaria uma entrega
   * contratada de 40.000 anúncios em ~31 mil narrativas na primeira madrugada.
   * Um contrato que ainda não precificou IA não pode ser cortado por um número
   * que não é dele — `pnpm ai:cost` dá o dado real para preencher depois.
   *
   * `@IsNumber` e não `@IsInt`: é dinheiro, e um teto de R$ 12,50 é legítimo.
   */
  @ApiPropertyOptional({
    example: 200,
    description:
      'Teto diário de gasto com IA, em moeda-base. Omitir deixa sem teto — o ' +
      'default de autoatendimento não se aplica a contrato.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  llmDailyBudgetBase?: number;

  @ApiProperty({ example: '2026-09-20T00:00:00.000Z' })
  @IsDateString()
  signedAt: string;

  @ApiPropertyOptional({ description: 'O documento assinado, quando há link.' })
  @IsOptional()
  @IsUrl()
  signedDocumentUrl?: string;
}

/**
 * A correção de um contrato ainda não ativado.
 *
 * Todos os campos são opcionais: omitir é manter. Número, lead e plano ficam
 * de fora de propósito — mudar o plano é vender outra coisa e mudar o lead é
 * outro cliente; nos dois casos o certo é um contrato novo.
 */
export class CorrectContractInputDto {
  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({ example: '2027-09-30T23:59:59.000Z' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;

  @ApiPropertyOptional({ enum: BillingIntervalDto })
  @IsOptional()
  @IsEnum(BillingIntervalDto)
  billingInterval?: BillingIntervalDto;

  @ApiPropertyOptional({ example: 60000 })
  @IsOptional()
  @IsNumber()
  @Min(0.01, { message: 'Contract amount must be greater than zero' })
  billingAmount?: number;

  @ApiPropertyOptional({ example: 8000, nullable: true })
  @IsOptional()
  @IsNumber()
  @Min(0)
  setupFeeAmount?: number | null;

  @ApiPropertyOptional({ example: 'BRL' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ enum: PaymentTermsDto })
  @IsOptional()
  @IsEnum(PaymentTermsDto)
  paymentTerms?: PaymentTermsDto;

  @ApiPropertyOptional({ enum: PaymentMethodDto })
  @IsOptional()
  @IsEnum(PaymentMethodDto)
  paymentMethod?: PaymentMethodDto;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  activateOnSignature?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @ApiPropertyOptional({
    description:
      'Informar **qualquer** teto substitui o conjunto inteiro; omitir todos ' +
      'mantém os atuais. Mesclar campo a campo impediria devolver um teto a ' +
      'nulo, que é o valor que diz "herda o plano".',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdAccounts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMonitoredAds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrganizations?: number;

  /**
   * O teto **diário** de gasto com IA, em moeda-base.
   *
   * Omitir deixa o contrato **sem teto**, e é o certo: o default de R$ 50/dia
   * foi calibrado para o maior plano de autoatendimento, e cortaria uma entrega
   * contratada de 40.000 anúncios em ~31 mil narrativas na primeira madrugada.
   * Um contrato que ainda não precificou IA não pode ser cortado por um número
   * que não é dele — `pnpm ai:cost` dá o dado real para preencher depois.
   *
   * `@IsNumber` e não `@IsInt`: é dinheiro, e um teto de R$ 12,50 é legítimo.
   */
  @ApiPropertyOptional({
    example: 200,
    description:
      'Teto diário de gasto com IA, em moeda-base. Omitir deixa sem teto — o ' +
      'default de autoatendimento não se aplica a contrato.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  llmDailyBudgetBase?: number;

  @ApiPropertyOptional({ example: '2026-09-20T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  signedAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  signedDocumentUrl?: string;
}

export class SuspendContractInputDto {
  @ApiProperty({
    enum: SuspensionReasonDto,
    description:
      'Quem suspendeu decide quem pode reabrir: `NON_PAYMENT` se desfaz com a ' +
      'baixa da fatura, `OPERATOR` só por ação humana.',
  })
  @IsEnum(SuspensionReasonDto)
  reason: SuspensionReasonDto;
}

export class ListContractsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  organizationId?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export class ContractOutputDto {
  @ApiProperty() id: string;
  @ApiProperty() contractNumber: string;
  @ApiProperty() salesLeadId: string;
  @ApiProperty({ nullable: true }) organizationId: string | null;
  @ApiProperty() planId: string;
  @ApiProperty() status: string;
  @ApiProperty() startsAt: string;
  @ApiProperty() endsAt: string;
  @ApiProperty() billingInterval: string;
  @ApiProperty() billingAmount: number;
  @ApiProperty({ nullable: true }) setupFeeAmount: number | null;
  @ApiProperty() currency: string;
  @ApiProperty() paymentTerms: string;
  @ApiProperty() paymentMethod: string;
  @ApiProperty() activateOnSignature: boolean;
  @ApiProperty() gracePeriodDays: number;
  @ApiProperty() autoRenew: boolean;
  @ApiProperty({ nullable: true }) maxSeats: number | null;
  @ApiProperty({ nullable: true }) maxAdAccounts: number | null;
  @ApiProperty({ nullable: true }) maxMonitoredAds: number | null;
  @ApiProperty({ nullable: true }) maxOrganizations: number | null;
  @ApiProperty() signedAt: string;
  @ApiProperty({ nullable: true }) signedDocumentUrl: string | null;
  @ApiProperty({ nullable: true }) activatedAt: string | null;
  @ApiProperty({ nullable: true }) suspendedAt: string | null;
  @ApiProperty({ nullable: true }) suspendedReason: string | null;
  @ApiProperty({ nullable: true }) canceledAt: string | null;
  @ApiProperty({
    nullable: true,
    description: 'O contrato que este renovou — a cadeia do histórico.',
  })
  renewedFromId: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Teto diário de custo de IA negociado, na moeda-base.',
  })
  llmDailyBudgetBase: number | null;

  @ApiPropertyOptional({
    description: 'Quando o contrato foi registrado na plataforma. Idem.',
  })
  createdAt?: string;

  @ApiPropertyOptional({
    description:
      'Empresa do lead. Presente na lista e no detalhe (`GET`), que são o que uma tela lê.',
  })
  leadCompanyName?: string;

  @ApiPropertyOptional({ nullable: true, description: 'Idem.' })
  organizationName?: string | null;

  @ApiPropertyOptional({ description: 'Idem.' })
  planName?: string;
}

export class ListContractsOutputDto {
  @ApiProperty({ type: [ContractOutputDto] }) items: ContractOutputDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() pageSize: number;
}

export class CreateAmendmentInputDto {
  @ApiProperty({
    example: '2027-01-01T00:00:00.000Z',
    description:
      'Quando a mudança passa a valer. Data de hoje ou passada aplica na ' +
      'hora; futura fica pendente e o job diário a escreve no dia.',
  })
  @IsDateString()
  effectiveAt: string;

  @ApiProperty({
    example: 'Expansão de equipe acordada na revisão trimestral',
    description: 'Por que foi acordado — é o que o operador lê meses depois.',
  })
  @IsString()
  @IsNotEmpty()
  reason: string;

  @ApiPropertyOptional({
    example: 72000,
    description: 'Novo valor da recorrência. Omitir mantém o atual.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  billingAmount?: number;

  @ApiPropertyOptional({
    example: 250,
    description: 'Omitir mantém o teto atual — não é "herda o plano" aqui.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdAccounts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMonitoredAds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrganizations?: number;

  /**
   * O teto **diário** de gasto com IA, em moeda-base.
   *
   * Omitir deixa o contrato **sem teto**, e é o certo: o default de R$ 50/dia
   * foi calibrado para o maior plano de autoatendimento, e cortaria uma entrega
   * contratada de 40.000 anúncios em ~31 mil narrativas na primeira madrugada.
   * Um contrato que ainda não precificou IA não pode ser cortado por um número
   * que não é dele — `pnpm ai:cost` dá o dado real para preencher depois.
   *
   * `@IsNumber` e não `@IsInt`: é dinheiro, e um teto de R$ 12,50 é legítimo.
   */
  @ApiPropertyOptional({
    example: 200,
    description:
      'Teto diário de gasto com IA, em moeda-base. Omitir deixa sem teto — o ' +
      'default de autoatendimento não se aplica a contrato.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  llmDailyBudgetBase?: number;
}

export class AmendmentOutputDto {
  @ApiProperty() id: string;
  @ApiProperty() number: string;
  @ApiProperty() contractId: string;
  @ApiProperty() organizationId: string;
  @ApiProperty() effectiveAt: string;
  @ApiProperty({ nullable: true }) appliedAt: string | null;
  @ApiProperty() reason: string;
  @ApiProperty({ description: 'Os novos valores; nulo é inalterado.' })
  changes: Record<string, number | null>;
  @ApiProperty({ description: 'O que havia antes, carimbado na aplicação.' })
  previous: Record<string, number | null>;
  @ApiProperty() createdBy: string;
  @ApiProperty() createdAt: string;
  @ApiPropertyOptional({
    description:
      'O uso de hoje em cada teto que o aditivo mexe — `{ used, ceiling, ' +
      'exceeds }` por dimensão. Informativo: uma redução datada é assinada ' +
      'antes de o cliente encolher. Vale sobretudo para `monitoredAds`, que ' +
      'é a única dimensão que sai da análise numa varredura em vez de ' +
      'recusar um clique.',
  })
  usage?: Record<string, { used: number; ceiling: number; exceeds: boolean }>;
}

export class RenewContractInputDto {
  @ApiProperty({
    example: '2027-10-01T00:00:00.000Z',
    description: 'Não pode começar antes de a vigência atual terminar.',
  })
  @IsDateString()
  startsAt: string;

  @ApiProperty({ example: '2028-09-30T23:59:59.000Z' })
  @IsDateString()
  endsAt: string;

  @ApiProperty({ example: '2027-09-15T00:00:00.000Z' })
  @IsDateString()
  signedAt: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  signedDocumentUrl?: string;

  @ApiPropertyOptional({
    example: 60000,
    description: 'Omitir mantém o valor do contrato atual.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0.01)
  billingAmount?: number;

  @ApiPropertyOptional({ description: 'Omitir mantém a tolerância atual.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  gracePeriodDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoRenew?: boolean;

  @ApiPropertyOptional({
    description:
      'Informar **qualquer** teto substitui o conjunto inteiro; omitir todos ' +
      'herda os tetos do contrato atual.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxSeats?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxAdAccounts?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxMonitoredAds?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  maxOrganizations?: number;

  /**
   * O teto **diário** de gasto com IA, em moeda-base.
   *
   * Omitir deixa o contrato **sem teto**, e é o certo: o default de R$ 50/dia
   * foi calibrado para o maior plano de autoatendimento, e cortaria uma entrega
   * contratada de 40.000 anúncios em ~31 mil narrativas na primeira madrugada.
   * Um contrato que ainda não precificou IA não pode ser cortado por um número
   * que não é dele — `pnpm ai:cost` dá o dado real para preencher depois.
   *
   * `@IsNumber` e não `@IsInt`: é dinheiro, e um teto de R$ 12,50 é legítimo.
   */
  @ApiPropertyOptional({
    example: 200,
    description:
      'Teto diário de gasto com IA, em moeda-base. Omitir deixa sem teto — o ' +
      'default de autoatendimento não se aplica a contrato.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  llmDailyBudgetBase?: number;
}

/**
 * Um contrato vivo cuja organização ainda não teve a IA precificada.
 *
 * `llm_daily_budget_base` nulo significa **sem teto** para `evaluateBudget`, e
 * isso é escolha legítima num contrato ainda não precificado — o default de
 * R$ 50/dia foi calibrado para o maior plano de autoatendimento e cortaria uma
 * entrega de 40.000 anúncios na primeira madrugada.
 *
 * O que não pode é ser escolha por omissão, e é para isso que esta listagem
 * existe.
 */
export class ContractWithoutAiBudgetDto {
  @ApiProperty({ example: 'uuid' }) contractId: string;
  @ApiProperty({ example: 'CT-2026-0007' }) number: string;
  @ApiProperty({ example: 'ACTIVE' }) status: string;
  @ApiProperty({ example: 'uuid' }) organizationId: string;
  @ApiProperty({ example: 'Rede Alfa' }) organizationName: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  activatedAt: string | null;

  @ApiProperty({
    example: 40000,
    nullable: true,
    description:
      'Os anúncios que o contrato vendeu — a escala que dimensiona o teto. ' +
      'Nulo herda o plano. O custo em reais vem de `pnpm ai:cost`, com dado ' +
      'medido, e não daqui.',
  })
  maxMonitoredAds: number | null;
}

export class ContractsWithoutAiBudgetOutputDto {
  @ApiProperty({ type: [ContractWithoutAiBudgetDto] })
  contracts: ContractWithoutAiBudgetDto[];
}
