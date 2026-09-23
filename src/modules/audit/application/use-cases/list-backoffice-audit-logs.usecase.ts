import { Injectable } from '@nestjs/common';
import { assertPlatformPermission } from 'src/modules/auth/application/platform-authorization';
import type { Operator } from 'src/modules/auth/domain/entities';
import { BackofficeAuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';
import { resolvePage } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { toBackofficeAuditLogOutput } from '../backoffice-audit-log.presenter';
import {
  ListBackofficeAuditLogsOutputDto,
  ListBackofficeAuditLogsQueryDto,
} from '../dtos';

@Injectable()
export class ListBackofficeAuditLogsUseCase {
  constructor(
    private readonly auditLogsRepository: BackofficeAuditLogsRepositoryInterface,
  ) {}

  async execute(
    operator: Operator,
    query: ListBackofficeAuditLogsQueryDto,
  ): Promise<ListBackofficeAuditLogsOutputDto> {
    assertPlatformPermission(operator, 'audit:read');

    const result = await this.auditLogsRepository.list(
      {
        actorId: query.actorId,
        action: query.action,
        subjectId: query.subjectId,
        from: query.from,
        to: query.to,
      },
      resolvePage(query),
    );

    return { ...result, items: result.items.map(toBackofficeAuditLogOutput) };
  }
}
