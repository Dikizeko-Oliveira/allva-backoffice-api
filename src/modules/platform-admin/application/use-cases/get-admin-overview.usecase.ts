import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  isPlatformRole,
  permissionsForRole,
} from 'src/modules/accounts/domain/platform-rbac';
import { metricsVisibleTo } from 'src/modules/platform-admin/domain/overview-metrics';
import { AdminOverviewReaderInterface } from 'src/modules/platform-admin/domain/ports';
import type { AdminOverviewDto } from '../dtos';

/**
 * `GET /api/v1/admin/overview` — B9, o Dashboard do backoffice.
 *
 * Exige `dashboard:read` e devolve **só** as métricas das áreas do operador,
 * como o "Requires attention" do hub: a do financeiro traz recorrência e
 * inadimplência, a do suporte traz chamados. A tela não decide nada por papel.
 */
@Injectable()
export class GetAdminOverviewUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly reader: AdminOverviewReaderInterface,
  ) {}

  async execute(
    actorId: string,
    now: Date = new Date(),
  ): Promise<AdminOverviewDto> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const permissions = permissionsForRole(actor.role);

    if (
      !isPlatformRole(actor.role) ||
      !permissions.includes('dashboard:read')
    ) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message:
          'Account not authorized: requires platform permission "dashboard:read"',
        details: { permission: 'dashboard:read' },
      });
    }

    const visible = metricsVisibleTo(permissions);
    const values = await this.reader.compute(
      visible.map((metric) => metric.key),
      now,
    );

    return {
      generatedAt: now.toISOString(),
      metrics: visible.map((metric) => ({
        key: metric.key,
        permission: metric.permission,
        unit: metric.unit,
        value: values[metric.key] ?? null,
        ...(metric.unit === 'MONEY' && { currency: 'BRL' }),
      })),
    };
  }
}
