import { assertPlatformPermission } from 'src/modules/accounts/application/platform-authorization';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AuditLogService } from 'src/modules/audit/application';
import {
  UpdateInvoiceStatusInputDto,
  UpdateInvoiceStatusOutputDto,
} from '../dtos';
import { InvoicesRepositoryInterface } from 'src/modules/invoices/domain/ports';

@Injectable()
export class UpdateInvoiceStatusUseCase {
  constructor(
    private readonly invoicesRepository: InvoicesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute(
    invoiceId: string,
    input: UpdateInvoiceStatusInputDto,
    actorId: string,
  ): Promise<UpdateInvoiceStatusOutputDto> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Actor account not found',
      });
    }

    /**
     * Operator-only, matching `CreateInvoiceUseCase`.
     *
     * This used to also accept the invoice's own account (`isOwner`), which let
     * a customer `PUT` their own pending invoice straight to `PAID`. No customer
     * flow needs to write an invoice status: every legitimate transition arrives
     * from Stripe via `HandleStripeWebhookUseCase`. The only person with
     * business correcting a financial record is an operator.
     */
    assertPlatformPermission(actor, 'billing:manage');

    const invoice = await this.invoicesRepository.findById(invoiceId);

    if (!invoice) {
      throw new NotFoundException({
        code: 'INVOICE_NOT_FOUND',
        message: 'Invoice not found',
      });
    }

    const previousStatus = invoice.status;

    if (!invoice.canTransitionTo(input.status)) {
      throw new ConflictException({
        code: 'INVALID_INVOICE_STATUS_TRANSITION',
        message: `Invoice cannot move from ${previousStatus} to ${input.status}`,
        from: previousStatus,
        to: input.status,
      });
    }

    // A legal no-op repeat is not worth a write or an audit row.
    if (previousStatus === input.status) {
      return {};
    }

    invoice.updateStatus(input.status);
    await this.invoicesRepository.updateStatus(invoice);

    await this.auditLog.record({
      event: 'invoice.status_changed',
      entityType: 'invoice',
      entityId: invoice.id,
      actorId: actor.id,
      metadata: {
        accountId: invoice.accountId,
        subscriptionId: invoice.subscriptionId,
        from: previousStatus,
        to: input.status,
      },
    });

    return {};
  }
}
