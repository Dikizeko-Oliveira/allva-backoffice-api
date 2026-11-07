import { Injectable, Logger } from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import {
  BackofficeAuditLog,
  CreateBackofficeAuditLogProps,
} from 'src/modules/audit/domain/entities';
import { BackofficeAuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';

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
 *
 * ## A origem vem do contexto da requisição
 *
 * `ip` e `userAgent` saem do `RequestContextService` — o IP já resolvido pelo
 * `CorrelationIdMiddleware` (provado pelo painel, GAP-033) — e não de cada use
 * case. Antes, só a atribuição de chamado os passava, e as outras 15 escritas
 * gravavam a origem vazia (GAP-046). Fora de uma requisição HTTP não há
 * contexto, e as colunas ficam `null`, como devem.
 */
@Injectable()
export class BackofficeAuditLogService {
  private readonly logger = new Logger(BackofficeAuditLogService.name);

  constructor(
    private readonly auditLogsRepository: BackofficeAuditLogsRepositoryInterface,
    private readonly requestContext: RequestContextService,
  ) {}

  async record({ actor, ...input }: RecordBackofficeAuditInput): Promise<void> {
    try {
      await this.auditLogsRepository.save(
        BackofficeAuditLog.create({
          ...input,
          actorId: actor.id,
          ip: input.ip ?? this.requestContext.getClientIp() ?? null,
          userAgent:
            input.userAgent ?? this.requestContext.getUserAgent() ?? null,
        }),
      );
    } catch (error) {
      this.logger.error(
        `audit.record_failed action=${input.action} subjectType=${input.subjectType} subjectId=${input.subjectId} actorId=${actor.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
