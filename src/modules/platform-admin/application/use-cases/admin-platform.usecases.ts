import { Injectable } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  AdminAuditReaderInterface,
  AdminPlatformReaderInterface,
} from 'src/modules/platform-admin/domain/ports';
import type {
  AdminAuditEventRow,
  AdminIntegrationRow,
  AdminJobRunRow,
  Page,
} from 'src/modules/platform-admin/domain/read-models';
import type {
  ListAdminAuditLogsQueryDto,
  ListAdminIntegrationsQueryDto,
  ListAdminJobRunsQueryDto,
} from '../dtos';
import { pageRequestOf } from '../page-request';

/**
 * `GET /api/v1/admin/integrations` — B5. `integrations:read`: operações e
 * suporte (diagnosticar "não sincroniza"). Nenhum token sai na resposta.
 */
@Injectable()
export class ListAdminIntegrationsUseCase {
  constructor(
    private readonly reader: AdminPlatformReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminIntegrationsQueryDto,
    actorId: string,
  ): Promise<Page<AdminIntegrationRow>> {
    await this.platformRole.assertPermission(actorId, 'integrations:read');

    return this.reader.listIntegrations({
      ...pageRequestOf(query),
      q: query.q,
      provider: query.provider,
      status: query.status,
      organizationId: query.organizationId,
    });
  }
}

/**
 * `GET /api/v1/admin/job-runs` — B6. A primeira leitura HTTP de `job_runs`:
 * até aqui, descobrir a janela que não aconteceu era consultar o banco.
 */
@Injectable()
export class ListAdminJobRunsUseCase {
  constructor(
    private readonly reader: AdminPlatformReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminJobRunsQueryDto,
    actorId: string,
    now: Date = new Date(),
  ): Promise<Page<AdminJobRunRow> & { jobNames: string[] }> {
    await this.platformRole.assertPermission(actorId, 'operations:read');

    const [page, jobNames] = await Promise.all([
      this.reader.listJobRuns(
        {
          ...pageRequestOf(query),
          status: query.status,
          jobName: query.jobName,
          stalled: query.stalled,
          from: query.from,
          to: query.to,
        },
        now,
      ),
      this.reader.listJobNames(),
    ]);

    return { ...page, jobNames };
  }
}

/**
 * `GET /api/v1/admin/audit-logs` — B8. `audit:read`: administração e
 * operações. Suporte e comercial veem o histórico da conta que atendem pelas
 * telas da área, não a trilha inteira.
 */
@Injectable()
export class ListAdminAuditLogsUseCase {
  constructor(
    private readonly reader: AdminAuditReaderInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    query: ListAdminAuditLogsQueryDto,
    actorId: string,
  ): Promise<Page<AdminAuditEventRow>> {
    await this.platformRole.assertPermission(actorId, 'audit:read');

    return this.reader.list({
      ...pageRequestOf(query),
      kind: query.kind,
      severity: query.severity,
      q: query.q,
      organizationId: query.organizationId,
      actorId: query.actorId,
      from: query.from,
      to: query.to,
    });
  }
}
