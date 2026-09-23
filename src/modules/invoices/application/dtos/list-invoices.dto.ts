import { ApiProperty } from '@nestjs/swagger';

class PlanDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Plano Básico' })
  name: string;

  @ApiProperty({ example: 199.99 })
  amount: number;

  @ApiProperty({ example: 'PRO' })
  type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';

  @ApiProperty({ example: 7 })
  trialDays: number | null;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  createdAt: Date;
}

class InvoiceDto {
  @ApiProperty({ example: 'uuid' })
  id: string;

  @ApiProperty({ example: 'uuid' })
  accountId: string;

  @ApiProperty({ example: 'uuid' })
  planId: string;

  @ApiProperty({ example: 'uuid' })
  /** Nulo na fatura de contrato: o Enterprise não tem assinatura de conta. */
  subscriptionId: string | null;
  /** O contrato que originou a fatura, quando ela vem de um. */
  contractId: string | null;

  @ApiProperty({ example: 'INV-0001' })
  number: string;

  @ApiProperty({ example: 'PENDING' })
  status: string;

  @ApiProperty({ example: 'STRIPE' })
  provider: string;

  @ApiProperty({ example: 199.99 })
  amount: number;

  @ApiProperty({ example: 'BRL' })
  currency: string;

  @ApiProperty({ example: '2026-04-18T00:00:00.000Z' })
  periodStart: Date;

  @ApiProperty({ example: '2026-05-18T00:00:00.000Z' })
  periodEnd: Date;

  @ApiProperty({ example: '2026-04-18T00:00:00.000Z', required: false })
  dueAt?: Date;

  @ApiProperty({ example: 'PAY-ABC123', required: false })
  externalReference?: string;

  @ApiProperty({ example: '123456789', required: false })
  externalInvoiceId?: string;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-03-15T00:00:00.000Z' })
  updatedAt: Date;

  @ApiProperty({ type: PlanDto, required: false })
  plan?: PlanDto;
}

export class ListInvoicesOutputDto {
  @ApiProperty({ type: [InvoiceDto] })
  invoices: InvoiceDto[];
}
