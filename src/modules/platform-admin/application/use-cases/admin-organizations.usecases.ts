import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AdminOrganizationsReaderInterface } from 'src/modules/platform-admin/domain/ports';
import type {
  AdminOrganizationDetail,
  AdminOrganizationRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import type { ListAdminOrganizationsQueryDto } from '../dtos';
import { pageRequestOf } from '../page-request';

/**
 * `GET /api/v1/admin/organizations` — B1 do mapa de endpoints do backoffice.
 *
 * `/api/v1/organizations` responde pelas organizações **do chamador**; esta
 * responde pela base inteira, e por isso exige `orgs:read`, que todo papel de
 * plataforma tem e nenhum cliente tem.
 */
@Injectable()
export class ListAdminOrganizationsUseCase {
  constructor(
    private readonly reader: AdminOrganizationsReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminOrganizationsQueryDto,
    actorId: string,
  ): Promise<Page<AdminOrganizationRow>> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    return this.reader.list({
      ...pageRequestOf(query),
      q: query.q,
      status: query.status,
      plan: query.plan,
    });
  }
}

/** `GET /api/v1/admin/organizations/:id` — B14. */
@Injectable()
export class GetAdminOrganizationUseCase {
  constructor(
    private readonly reader: AdminOrganizationsReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(id: string, actorId: string): Promise<AdminOrganizationDetail> {
    await this.platformRole.assertPermission(actorId, 'orgs:read');

    const organization = await this.reader.findById(id);

    if (!organization) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }

    return organization;
  }
}
