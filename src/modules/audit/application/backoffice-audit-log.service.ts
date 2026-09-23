import { Injectable, Logger } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  BackofficeAuditLog,
  CreateBackofficeAuditLogProps,
} from 'src/modules/audit/domain/entities';
import { BackofficeAuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';

export type RecordBackofficeAuditInput = Omit<
  CreateBackofficeAuditLogProps,
  'actorId'
> & { actor: Operator };

/**
 * Quem grava a trilha do backoffice-api.
 *
 * Mesmo contrato do `AuditLogService` do `allva-api`: gravar a auditoria
 * **nunca** derruba a operação que ela descreve. Uma falha aqui é logada com o
 * que identifica a linha perdida, e a escrita do operador segue.
 */
@Injectable()
export class BackofficeAuditLogService {
  private readonly logger = new Logger(BackofficeAuditLogService.name);

  constructor(
    private readonly auditLogsRepository: BackofficeAuditLogsRepositoryInterface,
  ) {}

  async record({ actor, ...input }: RecordBackofficeAuditInput): Promise<void> {
    try {
      await this.auditLogsRepository.save(
        BackofficeAuditLog.create({ ...input, actorId: actor.id }),
      );
    } catch (error) {
      this.logger.error(
        `audit.record_failed action=${input.action} subjectType=${input.subjectType} subjectId=${input.subjectId} actorId=${actor.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
