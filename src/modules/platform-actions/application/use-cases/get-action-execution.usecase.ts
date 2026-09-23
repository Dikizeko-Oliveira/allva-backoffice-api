import { Injectable, NotFoundException } from '@nestjs/common';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';

/**
 * `GET /ads/actions/executions/{id}` — o alvo do `Location` do 202.
 *
 * **Os dois estados chegam separados** (§8.4). É o que permite a tela dizer
 * "pausando…" enquanto `desiredStatus` e `observedStatus` divergem, e "pausado"
 * só quando o sync confirmar. Um campo `status` único obrigaria o cliente a
 * escolher qual verdade mostrar — e ele escolheria a otimista.
 */
@Injectable()
export class GetActionExecutionUseCase {
  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
  ) {}

  async execute(input: { organizationId: string; executionId: string }) {
    const execution = await this.executions.findExecution(input);

    if (!execution) throw new NotFoundException('Execução não encontrada');

    return envelope(
      {
        executionId: execution.executionId,
        actionId: execution.actionId,
        adId: execution.adId,
        actionType: execution.actionType,
        level: execution.level,
        target: {
          type: execution.targetEntityType,
          id: execution.targetEntityId,
        },
        status: execution.status,
        attempt: execution.attempt,
        dryRun: execution.dryRun,
        validationDepth: execution.validationDepth,
        state: {
          observedStatus: execution.observedStatus,
          desiredStatus: execution.desiredStatus,
          /**
           * A pergunta que a tela realmente faz. Deixá-la para o cliente
           * calcular convidaria cada um a inventar a própria regra — e a
           * primeira a divergir seria a que decide quando parar de mostrar o
           * spinner.
           */
          converged:
            execution.desiredStatus === null ||
            execution.desiredStatus === execution.observedStatus,
        },
        verification: {
          attempt: execution.verificationAttempt,
          verifiedAt: execution.verifiedAt,
          result: execution.verificationResult,
        },
        error: execution.errorCode
          ? { code: execution.errorCode, message: execution.errorMessage }
          : null,
        resultPlatformEntityId: execution.resultPlatformEntityId,
        expiresAt: execution.expiresAt,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
        createdAt: execution.createdAt,
      },
      { asOf: new Date().toISOString() },
    );
  }
}
