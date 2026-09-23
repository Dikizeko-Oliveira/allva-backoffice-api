import { Injectable } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AdminBillingReaderInterface } from 'src/modules/platform-admin/domain/ports';
import type {
  AdminInvoiceRow,
  AdminSubscriptionRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import type {
  ListAdminInvoicesQueryDto,
  ListAdminSubscriptionsQueryDto,
} from '../dtos';
import { pageRequestOf } from '../page-request';

/** `GET /api/v1/admin/subscriptions` — B4. */
@Injectable()
export class ListAdminSubscriptionsUseCase {
  constructor(
    private readonly reader: AdminBillingReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminSubscriptionsQueryDto,
    actorId: string,
  ): Promise<Page<AdminSubscriptionRow>> {
    await this.platformRole.assertPermission(actorId, 'subscriptions:read');

    return this.reader.listSubscriptions({
      ...pageRequestOf(query),
      q: query.q,
      status: query.status,
      plan: query.plan,
    });
  }
}

/**
 * `GET /api/v1/admin/invoices` — B12.
 *
 * Todas as faturas da base, de assinatura e de contrato. `billing:read` —
 * suporte vê a assinatura de quem atende, não o livro de cobrança.
 */
@Injectable()
export class ListAdminInvoicesUseCase {
  constructor(
    private readonly reader: AdminBillingReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminInvoicesQueryDto,
    actorId: string,
    now: Date = new Date(),
  ): Promise<Page<AdminInvoiceRow>> {
    await this.platformRole.assertPermission(actorId, 'billing:read');

    return this.reader.listInvoices(
      {
        ...pageRequestOf(query),
        q: query.q,
        status: query.status,
        overdue: query.overdue,
        organizationId: query.organizationId,
      },
      now,
    );
  }
}
