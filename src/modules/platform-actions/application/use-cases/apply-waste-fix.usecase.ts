import { Injectable } from '@nestjs/common';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { ApplyRecommendationPlanUseCase } from 'src/modules/platform-actions/application/use-cases/apply-recommendation-plan.usecase';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type ApplyWasteFixInput = {
  organizationId: string;
  accountId: string;
  wasteItemId: string;
  dryRun?: boolean;
  confirmedContentDigests?: Record<string, string>;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * `POST /waste/items/{id}/apply-fix` — a linha "por ação" de §10.9.
 *
 * **Dívida de A2-S5, desbloqueada em A2-S7, entregue em A2-S9.** Ela sempre
 * dependeu de "executar" existir; enquanto não existia, era impedimento, e
 * depois virou trabalho — e atravessou A2-S8 sem entrar.
 *
 * **Não há caminho de escrita novo aqui.** A rota traduz achado → recomendação e
 * delega ao apply, que delega ao `ExecuteActionUseCase`. Resolver o achado é
 * consequência do passo 8 de §9.5, que já roda quando o plano assenta: um
 * caminho próprio que fechasse o item por conta resolveria desperdício sem que
 * escrita nenhuma tivesse acontecido.
 *
 * **Resolve TODOS os itens vinculados**, e é por isso que ele existe em vez de
 * `PATCH /resolve`: a relação é N:N, um plano coerente responde a vários sinais
 * do mesmo anúncio, e fechar só o item clicado deixaria a tela cobrando ação
 * sobre um anúncio que a ação acabou de corrigir.
 */
@Injectable()
export class ApplyWasteFixUseCase {
  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly applyPlan: ApplyRecommendationPlanUseCase,
  ) {}

  async execute(input: ApplyWasteFixInput) {
    const recommendation = await this.recommendations.findActiveByWasteItem({
      organizationId: input.organizationId,
      wasteItemId: input.wasteItemId,
    });

    /**
     * Achado sem plano ativo é o caso normal, não um erro do sistema — nem todo
     * diagnóstico tem remédio dentro do escopo da Allva (`EXPAND_AUDIENCE` é
     * consultivo por decisão). O erro tipado diz **qual** é o caminho: resolver
     * manualmente. Um 404 genérico faria a tela concluir que o item não existe.
     */
    if (!recommendation) {
      throw new DomainError({
        code: 'NO_ACTIVE_RECOMMENDATION_FOR_FINDING',
        category: 'PRECONDITION_FAILED',
        message:
          'Não há recomendação ativa que corrija este achado por ação da Allva.',
        details: { wasteItemId: input.wasteItemId },
        remediation:
          'Use PATCH /waste/items/{id}/resolve para registrar a resolução manual.',
      });
    }

    return this.applyPlan.execute({
      organizationId: input.organizationId,
      accountId: input.accountId,
      recommendationId: recommendation.id,
      body: {
        dryRun: input.dryRun,
        confirmedContentDigests: input.confirmedContentDigests,
      },
      correlationId: input.correlationId,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });
  }
}
