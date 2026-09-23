import { Injectable, Logger } from '@nestjs/common';
import { RecommendationApplicationService } from 'src/modules/recommendations/application/services/recommendation-application.service';
import { ActionExecutionsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import type { JobContext } from 'src/shared/domain/events/job-context';

/**
 * §9.5 passo 5 — **quem observa o plano inteiro assentar**.
 *
 * Vive em `platform-actions` porque a pergunta é sobre execuções, e execuções
 * são dele. A resposta — o que a recomendação vira — é de `recommendations`, e é
 * para lá que a chamada vai. A direção do grafo permite (§5.3 r.5); inverter
 * daria a `recommendations` conhecimento de escrita, que é justamente o que a
 * regra existe para impedir.
 *
 * **Chamado a cada execução que assenta, não uma vez no fim.** Não há "fim"
 * observável: cada execução termina no seu próprio job, e a última a terminar é
 * a única que sabe que é a última — porque conta as outras.
 */
@Injectable()
export class RecommendationSettlementService {
  private readonly logger = new Logger(RecommendationSettlementService.name);

  constructor(
    private readonly executions: ActionExecutionsRepositoryInterface,
    private readonly application: RecommendationApplicationService,
  ) {}

  async onExecutionSettled(input: {
    organizationId: string;
    recommendationId: string;
    requestedByAccountId: string | null;
    ctx: JobContext;
  }): Promise<void> {
    const plan = await this.executions.planStatusFor({
      organizationId: input.organizationId,
      recommendationId: input.recommendationId,
    });

    // Ainda há escrita em voo: a recomendação continua `APPLYING`, que é o
    // estado honesto. Declará-la aplicada com uma ação pendente prometeria um
    // efeito que a plataforma ainda pode recusar.
    if (plan.pending > 0) return;

    /**
     * **Nenhuma execução real ainda.** Acontece quando o primeiro `settle` do
     * lote chega antes de a última ação ser enfileirada — a leitura é uma foto,
     * e a foto pode ser de um instante intermediário. Sair sem fazer nada é
     * correto: a execução seguinte reavalia com o plano completo.
     */
    if (plan.executionIds.length === 0) return;

    /**
     * Ações que não chegaram a virar execução — recusadas por guarda, ou
     * enfileiradas em outra requisição que falhou. O plano não foi executado
     * inteiro, e um plano parcialmente executado **não** é uma aplicação.
     */
    const unexecuted = plan.plannedActions - plan.executionIds.length;

    const allSucceeded =
      plan.failed === 0 && unexecuted <= 0 && plan.succeeded > 0;

    const result = await this.application.settle({
      organizationId: input.organizationId,
      recommendationId: input.recommendationId,
      allSucceeded,
      failureDetail: allSucceeded ? null : failureDetailOf(plan, unexecuted),
      executionIds: plan.executionIds,
      lastSettledExecutionId: plan.lastSettledExecutionId,
      settledAt: plan.settledAt ?? new Date(),
      actorId: input.requestedByAccountId,
      ctx: input.ctx,
    });

    this.logger.log(
      `recommendation.settled id=${input.recommendationId} desfecho=${result.kind} ` +
        `execuções=${plan.succeeded}/${plan.plannedActions}`,
    );
  }
}

function failureDetailOf(
  plan: { failed: number; succeeded: number },
  unexecuted: number,
): string {
  if (plan.failed > 0) {
    return `${plan.failed} ação(ões) do plano não foram aceitas pela plataforma.`;
  }

  if (unexecuted > 0) {
    return `${unexecuted} ação(ões) do plano não chegaram a ser enfileiradas.`;
  }

  return 'O plano não produziu nenhuma escrita bem-sucedida.';
}
