import { Injectable } from '@nestjs/common';
import {
  ApplyRecommendationUseCase,
  windowDaysOf,
} from 'src/modules/recommendations/application/use-cases/apply-recommendation.usecase';
import { RecommendationApplicationService } from 'src/modules/recommendations/application/services/recommendation-application.service';
import type { ApplyRecommendationDto } from 'src/modules/recommendations/application/dtos/recommendation-query.dto';
import { ApplyPlanExecutorService } from 'src/modules/platform-actions/application/services/apply-plan-executor.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type ApplyPlanInput = {
  organizationId: string;
  accountId: string;
  recommendationId: string;
  body: ApplyRecommendationDto;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
};

/**
 * `POST /recommendations/{id}/apply` com escrita real — §9.5 passos 1 a 4.
 *
 * **Rota de `recommendations`, controller de `platform-actions`** (D3). É a
 * mesma resolução de `POST /ads/{id}/actions`: `recommendations` não pode
 * importar quem escreve (§5.3 r.5), e o caminho HTTP pertence ao produto, não ao
 * módulo. Manter a rota do lado de lá exigiria ou inverter o grafo, ou um
 * segundo caminho de escrita — e o segundo caminho é sempre o que não tem as
 * guardas.
 *
 * **Nada aqui revalida por conta própria.** O passo 1 vive em `recommendations`
 * e é chamado; duplicá-lo criaria duas definições de "a premissa ainda vale", e
 * a que erra é sempre a que ninguém revisita.
 */
@Injectable()
export class ApplyRecommendationPlanUseCase {
  constructor(
    private readonly dryRunApply: ApplyRecommendationUseCase,
    private readonly application: RecommendationApplicationService,
    private readonly executor: ApplyPlanExecutorService,
  ) {}

  async execute(input: ApplyPlanInput) {
    // Ausente é dry-run: pedir a escrita real é sempre explícito.
    if (input.body.dryRun !== false) {
      return this.dryRunApply.execute({
        organizationId: input.organizationId,
        id: input.recommendationId,
        body: input.body,
      });
    }

    const recommendation = await this.dryRunApply.revalidate({
      organizationId: input.organizationId,
      id: input.recommendationId,
    });

    if (recommendation.actions.length === 0) {
      throw new DomainError({
        code: 'RECOMMENDATION_HAS_NO_ACTIONS',
        category: 'UNSUPPORTED_BY_PLATFORM',
        message: 'Esta recomendação não tem ação executável.',
        remediation: 'Siga a orientação no gerenciador da plataforma.',
      });
    }

    await this.begin(input);

    const report = await this.executor.run(
      {
        organizationId: input.organizationId,
        accountId: input.accountId,
        recommendationId: input.recommendationId,
        adId: recommendation.ad.id,
        confirmedContentDigests: input.body.confirmedContentDigests,
        correlationId: input.correlationId,
        ipAddress: input.ipAddress,
        userAgent: input.userAgent,
      },
      recommendation.actions,
    );

    const accepted = report.filter((item) => item.accepted).length;

    /**
     * **Nenhuma aceita ⇒ o plano falha na hora.** Sem isto a recomendação
     * ficaria `APPLYING` sem nenhuma execução para tirá-la de lá: a liquidação
     * só corre quando uma execução assenta, e não há nenhuma.
     */
    if (accepted === 0) {
      await this.application.abort({
        organizationId: input.organizationId,
        recommendationId: input.recommendationId,
        reason:
          report.at(0)?.refusal?.message ??
          'Nenhuma ação do plano pôde ser enfileirada.',
      });
    }

    return envelope(
      {
        recommendationId: input.recommendationId,
        dryRun: false,
        status: accepted === 0 ? 'FAILED' : 'APPLYING',
        /**
         * **Relatório por ação, não um status pelo conjunto.** A resposta não
         * afirma que o anúncio foi pausado: afirma que aceitamos a intenção e
         * que a plataforma ainda não respondeu. O desfecho de cada uma se
         * acompanha em `/ads/actions/executions/{id}`, e o da recomendação,
         * relendo-a.
         */
        actions: report,
        outcomeWindowDays: windowDaysOf(recommendation),
      },
      {
        asOf: new Date().toISOString(),
        dataMaturity: recommendation.dataMaturity ?? undefined,
        provenance: {
          engineVersion: recommendation.engineVersion,
          windowDays: windowDaysOf(recommendation),
        },
      },
    );
  }

  /**
   * Passo 4 — a recomendação entra em voo **antes** da primeira escrita.
   *
   * `false` significa que ela já não está em `NEW`/`ACKNOWLEDGED`: outro clique
   * chegou primeiro, ou o ciclo de vida a expirou entre a revalidação e agora.
   * Recusar aqui é o que impede dois cliques de dispararem o mesmo plano duas
   * vezes — I2 protege o **alvo**, e um plano com dois alvos passaria por ela.
   */
  private async begin(input: ApplyPlanInput): Promise<void> {
    const started = await this.application.begin({
      organizationId: input.organizationId,
      recommendationId: input.recommendationId,
    });

    if (started) return;

    throw new DomainError({
      code: 'RECOMMENDATION_NOT_APPLICABLE',
      category: 'PRECONDITION_FAILED',
      message:
        'Esta recomendação já está sendo aplicada, ou já saiu da tela de decisão.',
      remediation:
        'Recarregue a lista: o estado atual dela responde o que aconteceu.',
    });
  }
}
