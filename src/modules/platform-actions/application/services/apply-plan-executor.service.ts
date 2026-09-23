import { Injectable, Logger } from '@nestjs/common';
import type { RecommendationActionView } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { ExecuteActionUseCase } from 'src/modules/platform-actions/application/use-cases/execute-action.usecase';
import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** O desfecho de uma ação do plano, na forma que o relatório expõe. */
export type PlanItemReport = {
  actionId: string;
  type: string;
  accepted: boolean;
  executionId: string | null;
  refusal: { code: string; message: string } | null;
};

export type ApplyPlanContext = {
  organizationId: string;
  accountId: string;
  recommendationId: string;
  adId: string;
  confirmedContentDigests?: Record<string, string>;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * O laço de §9.5 passo 4 — **uma ação por vez, pelo caminho de escrita único**.
 *
 * Sequencial, não paralelo, pela mesma razão do lote de A2-S8: escritas
 * simultâneas esgotam o balde de tokens de R4, e o teto por rajada de C10 seria
 * lido antes de qualquer incremento — deixando passar um plano inteiro por um
 * limite que existia para contê-lo.
 *
 * **A recusa de uma ação vira linha do relatório, não exceção que sobe.**
 * Abortar no meio deixaria as anteriores já escritas na plataforma e nenhuma
 * explicação de quais foram — que é exatamente o trabalho que o relatório existe
 * para tirar de quem vai investigar.
 */
@Injectable()
export class ApplyPlanExecutorService {
  private readonly logger = new Logger(ApplyPlanExecutorService.name);

  constructor(private readonly executeAction: ExecuteActionUseCase) {}

  async run(
    context: ApplyPlanContext,
    actions: RecommendationActionView[],
  ): Promise<PlanItemReport[]> {
    const report: PlanItemReport[] = [];

    for (const action of actions) {
      report.push(await this.runOne(context, action));
    }

    return report;
  }

  private async runOne(
    context: ApplyPlanContext,
    action: RecommendationActionView,
  ): Promise<PlanItemReport> {
    try {
      const result = await this.executeAction.execute({
        organizationId: context.organizationId,
        accountId: context.accountId,
        adId: context.adId,
        body: {
          type: action.type as AdActionType,
          parameters: action.parameters,
          dryRun: false,
          // R14 — o dígito **do conteúdo** que o usuário confirmou, por ação.
          confirmedContentDigest: context.confirmedContentDigests?.[action.id],
        },
        /**
         * Chave **derivada**, como no lote: `reco:{recomendação}:{ação}`. Um
         * retry do mesmo apply reencontra as mesmas chaves e devolve as mesmas
         * execuções, sem disparar uma segunda rodada de escritas (A8).
         */
        idempotencyKey: `reco:${context.recommendationId}:${action.id}`,
        correlationId: context.correlationId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        origin: 'RECOMMENDATION',
        recommendationId: context.recommendationId,
        // Aplicar é executar a `AdAction` do plano, não criar outra (P3).
        existingActionId: action.id,
      });

      return {
        actionId: action.id,
        type: action.type,
        accepted: result.executionId !== null,
        executionId: result.executionId,
        refusal: null,
      };
    } catch (error) {
      const refusal =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : {
              code: 'ACTION_FAILED',
              message: 'A ação não pôde ser executada.',
            };

      this.logger.warn(
        `recommendation.apply_item_refused recomendação=${context.recommendationId} ` +
          `ação=${action.id} código=${refusal.code}`,
      );

      return {
        actionId: action.id,
        type: action.type,
        accepted: false,
        executionId: null,
        refusal,
      };
    }
  }
}
