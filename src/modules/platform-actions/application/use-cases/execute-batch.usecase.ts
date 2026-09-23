import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  checkBatch,
  summarize,
} from 'src/modules/platform-actions/domain/batch';
import type { BatchItemOutcome } from 'src/modules/platform-actions/domain/batch';
import { CreateAdActionBatchDto } from 'src/modules/platform-actions/application/dtos/create-ad-action-batch.dto';
import { ExecuteActionUseCase } from 'src/modules/platform-actions/application/use-cases/execute-action.usecase';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planFeatureRefusal } from 'src/modules/platform-actions/application/errors/write-refusals';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type ExecuteBatchInput = {
  organizationId: string;
  accountId: string;
  body: CreateAdActionBatchDto;
  idempotencyKey: string;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * `POST /ads/actions/batch` — §13.5, entrega 6.
 *
 * **Cada item é revalidado individualmente, e a recusa de um não aborta o
 * lote.** O usuário pediu doze pausas; se duas forem recusadas porque os
 * anúncios já estavam pausados, as outras dez acontecem. Abortar devolveria a
 * ele o trabalho de descobrir quais passariam — que é exatamente o trabalho que
 * o lote existe para tirar dele.
 *
 * **Não há caminho de escrita novo aqui.** Cada item passa pelo mesmo
 * `ExecuteActionUseCase` da escrita individual, com a mesma cadeia de P5: kill
 * switch, consentimento, disponibilidade, teto, I2, idempotência. Um lote que
 * chamasse o repositório direto seria uma segunda porta de escrita, e a segunda
 * porta é a que não tem as guardas.
 */
@Injectable()
export class ExecuteBatchUseCase {
  constructor(
    private readonly executeAction: ExecuteActionUseCase,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  async execute(input: ExecuteBatchInput) {
    const refusal = checkBatch({
      items: input.body.items,
      validationDepth: input.body.validationDepth,
    });

    // As guardas do lote valem para o pedido inteiro: recusá-lo item a item
    // produziria cem linhas dizendo a mesma coisa sobre algo que era inválido
    // como um todo.
    if (refusal) throw new DomainError(refusal);

    /**
     * O lote é uma capacidade em si, separada das ações que ele carrega: um
     * plano pode incluir pausar anúncio e não incluir pausar doze de uma vez.
     *
     * Recusado **antes** do laço, e como pedido inteiro: cada item já será
     * revalidado adiante, mas deixar o laço rodar produziria doze recusas
     * idênticas dizendo que o plano não inclui o lote — quando o que não foi
     * incluído é o pedido, não cada anúncio.
     */
    const batchState = await this.planEntitlement.stateFor({
      organizationId: input.organizationId,
      feature: 'batch-actions',
    });

    if (!batchState.allowed) throw planFeatureRefusal(batchState);

    const batchId = randomUUID();
    const items: Array<
      {
        adId: string;
        type: (typeof input.body.items)[number]['type'];
      } & BatchItemOutcome
    > = [];

    /**
     * **Sequencial, não paralelo.** Cem escritas simultâneas contra a mesma
     * conta esgotariam o balde de tokens de R4 e a plataforma responderia
     * `429` para a maioria — transformando um lote válido num relatório cheio
     * de falhas temporárias. O teto por rajada da organização (C10) também é
     * avaliado por item, e em paralelo ele seria lido antes de qualquer
     * incremento, deixando cem escritas passarem por um limite de trinta.
     */
    for (const item of input.body.items) {
      items.push({
        adId: item.adId,
        type: item.type,
        ...(await this.runItem(input, item, batchId)),
      });
    }

    return envelope(summarize(items, batchId), {
      asOf: new Date().toISOString(),
    });
  }

  private async runItem(
    input: ExecuteBatchInput,
    item: CreateAdActionBatchDto['items'][number],
    batchId: string,
  ): Promise<BatchItemOutcome> {
    try {
      const result = await this.executeAction.execute({
        organizationId: input.organizationId,
        accountId: input.accountId,
        adId: item.adId,
        body: {
          type: item.type,
          parameters: item.parameters,
          dryRun: input.body.dryRun,
        },
        /**
         * Chave derivada do lote e do item: um retry do lote inteiro reencontra
         * as mesmas chaves e devolve as mesmas execuções, em vez de disparar uma
         * segunda rodada de escritas. É A8 aplicado ao lote sem inventar um
         * mecanismo novo.
         */
        idempotencyKey: `${input.idempotencyKey}:${item.adId}:${item.type}`,
        correlationId: input.correlationId ?? batchId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      });

      return result.executionId
        ? { status: 'ACCEPTED', executionId: result.executionId }
        : // Dry-run não cria execução: o item é "aceito" no sentido de ter
          // passado pelas guardas, e o relatório do lote é o que o usuário lê.
          { status: 'ACCEPTED', executionId: `dry-run:${item.adId}` };
    } catch (error) {
      /**
       * A recusa vira **linha do relatório**, não exceção que sobe. Deixá-la
       * subir abortaria o lote no primeiro item problemático, e o usuário
       * receberia menos informação do que se tivesse clicado doze vezes.
       */
      if (error instanceof DomainError) {
        return {
          status: 'REFUSED',
          code: error.code,
          message: error.message,
        };
      }

      return {
        status: 'REFUSED',
        code: 'UNEXPECTED_ERROR',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
