import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { InvoiceStatus } from 'src/modules/invoices/domain/invoice-status-policy';

/**
 * `class-validator` needs a runtime enum; the domain owns the type. The
 * `satisfies` makes the two drift apart at compile time rather than at request
 * time — a status added to `InvoiceStatus` and forgotten here fails `tsc`.
 */
const InvoiceStatusValues = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELED: 'CANCELED',
  EXPIRED: 'EXPIRED',
} satisfies Record<InvoiceStatus, InvoiceStatus>;

export class UpdateInvoiceStatusInputDto {
  @IsEnum(InvoiceStatusValues, { message: 'Status is invalid' })
  @ApiProperty({
    example: InvoiceStatusValues.PAID,
    enum: InvoiceStatusValues,
  })
  status: InvoiceStatus;
}

export class UpdateInvoiceStatusOutputDto {}
