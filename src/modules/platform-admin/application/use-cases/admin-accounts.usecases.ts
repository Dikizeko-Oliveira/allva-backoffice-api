import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  PLATFORM_ROLES,
  roleHasPlatformPermission,
} from 'src/modules/accounts/domain/platform-rbac';
import { AdminAccountsReaderInterface } from 'src/modules/platform-admin/domain/ports';
import type {
  AdminAccountDetail,
  AdminCustomerMembershipRow,
  AdminOperatorRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import type {
  ListAdminCustomersQueryDto,
  ListAdminOperatorsQueryDto,
} from '../dtos';
import { pageRequestOf } from '../page-request';

/**
 * `GET /api/v1/admin/accounts/customers` — B2, lado cliente.
 *
 * `users:read`: suporte e financeiro consultam quem é quem numa conta que
 * atendem; comercial e operações não precisam.
 */
@Injectable()
export class ListAdminCustomersUseCase {
  constructor(
    private readonly reader: AdminAccountsReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminCustomersQueryDto,
    actorId: string,
  ): Promise<Page<AdminCustomerMembershipRow>> {
    await this.platformRole.assertPermission(actorId, 'users:read');

    return this.reader.listCustomers({
      ...pageRequestOf(query),
      q: query.q,
      status: query.status,
      organizationId: query.organizationId,
      plan: query.plan,
    });
  }
}

/**
 * `GET /api/v1/admin/accounts/operators` — B2, lado operador.
 *
 * O filtro `permission` é traduzido **aqui**, pela matriz do servidor, nos
 * papéis que a têm. É o que deixa o backoffice perguntar "quem pode assumir um
 * chamado" (`support:manage`) sem ter a própria cópia da matriz — a pergunta
 * que antes ele respondia com `roleHasPlatformPermission` local.
 */
@Injectable()
export class ListAdminOperatorsUseCase {
  constructor(
    private readonly reader: AdminAccountsReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminOperatorsQueryDto,
    actorId: string,
  ): Promise<Page<AdminOperatorRow>> {
    await this.platformRole.assertPermission(actorId, 'users:read');

    const roles = query.permission
      ? PLATFORM_ROLES.filter((role) =>
          roleHasPlatformPermission(role, query.permission!),
        )
      : undefined;

    return this.reader.listOperators({
      ...pageRequestOf(query),
      q: query.q,
      status: query.status,
      platformRole: query.platformRole,
      permission: query.permission,
      roles,
    });
  }
}

/** `GET /api/v1/admin/accounts/:id` — detalhe de cliente ou operador. */
@Injectable()
export class GetAdminAccountUseCase {
  constructor(
    private readonly reader: AdminAccountsReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(id: string, actorId: string): Promise<AdminAccountDetail> {
    await this.platformRole.assertPermission(actorId, 'users:read');

    const account = await this.reader.findById(id);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    return account;
  }
}
