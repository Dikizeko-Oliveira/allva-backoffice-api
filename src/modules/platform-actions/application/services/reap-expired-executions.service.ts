import { Injectable, Logger } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { RecommendationSettlementService } from 'src/modules/platform-actions/application/services/recommendation-settlement.service';
import {
  createRootJobContext,
  type JobContext,
} from 'src/shared/domain/events/job-context';

/** Um lote por passada. O reaper roda a cada 5 min; não precisa esvaziar tudo. */
const REAP_BATCH = 200;

/**
 * A varredura de `expiresAt` (C2, ⊕6, entrega 5).
 *
 * **É o caminho de saída de um estado não terminal** (§16.16). Uma execução que
 * trava em `QUEUED` — worker morto, Redis reiniciado, deploy no meio — segura o
 * índice parcial `action_executions_inflight_unique` para sempre, e o alvo fica
 * permanentemente irrescrevível: toda tentativa nova recebe `WRITE_IN_FLIGHT`
 * apontando para uma execução que ninguém vai processar. Sem o reaper, o produto
 * teria uma forma silenciosa de bloquear um anúncio até alguém mexer no banco.
 *
 * **`expiresAt` mede a execução, nunca a verificação.** São 15 minutos desde o
 * pedido, e a escada vai a duas horas: dimensionar o prazo pela escada faria o
 * reaper só disparar depois que o problema já custou duas horas de I2 preso.
 */
@Injectable()
export class ReapExpiredExecutionsService {
  private readonly logger = new Logger(ReapExpiredExecutionsService.name);

  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly audit: AuditLogService,
    private readonly settlement: RecommendationSettlementService,
  ) {}

  async reap(
    now: Date,
    ctx: JobContext = createRootJobContext(),
  ): Promise<{ reaped: number; adIds: string[] }> {
    const expired = await this.executions.findExpired({
      now,
      limit: REAP_BATCH,
    });

    const adIds: string[] = [];

    for (const execution of expired) {
      /**
       * `CANCELLED`, não `FAILED`. A distinção é honesta: não sabemos se a
       * plataforma foi chamada — uma execução em `RUNNING` pode ter escrito e
       * morrido antes de gravar o desfecho. `FAILED` afirmaria que não pegou, e
       * é exatamente o que ninguém pode afirmar aqui.
       */
      await this.executions.settle({
        executionId: execution.executionId,
        status: 'CANCELLED',
        errorCode: 'EXECUTION_EXPIRED',
        errorMessage:
          execution.status === 'RUNNING'
            ? 'A execução venceu em andamento; não é possível afirmar se a plataforma foi alterada.'
            : 'A execução venceu na fila sem ser processada.',
        /**
         * O estado otimista sai. O `syncState` fica em `PENDING_WRITE` até o
         * `sync` reler — e é justamente o caso em que reler mais importa, porque
         * é o único em que não sabemos o que a plataforma tem.
         */
        clearDesiredStatus: true,
      });

      await this.audit.record({
        event: 'ad.action.failed',
        entityType: 'ActionExecution',
        entityId: execution.executionId,
        organizationId: execution.organizationId,
        metadata: {
          adId: execution.adId,
          reason: 'EXECUTION_EXPIRED',
          statusWhenReaped: execution.status,
          attempt: execution.attempt,
        },
      });

      /**
       * §16.16 aplicado à recomendação, não só à execução.
       *
       * Recolher a execução e parar aqui deixaria a recomendação em `APPLYING`
       * para sempre — o mesmo estado sem saída que o reaper existe para
       * eliminar, um nível acima. A tela diria "aplicando…" indefinidamente
       * sobre uma escrita que ninguém vai processar.
       */
      if (execution.recommendationId) {
        await this.settlement.onExecutionSettled({
          organizationId: execution.organizationId,
          recommendationId: execution.recommendationId,
          requestedByAccountId: execution.requestedByAccountId,
          ctx,
        });
      }

      adIds.push(execution.adId);
    }

    if (expired.length > 0) {
      this.logger.warn(
        `action.reaped total=${expired.length} running=${
          expired.filter((item) => item.status === 'RUNNING').length
        }`,
      );
    }

    return { reaped: expired.length, adIds };
  }
}
