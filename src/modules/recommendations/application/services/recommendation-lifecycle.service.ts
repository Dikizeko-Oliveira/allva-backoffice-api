import { Injectable, Logger } from '@nestjs/common';
import { JobContext } from 'src/shared/domain/events/job-context';
import { decideTransitions } from 'src/modules/recommendations/domain/lifecycle';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { SuppressionsRepositoryInterface } from 'src/modules/recommendations/domain/ports/suppressions.repository';

export type LifecycleOutcome = {
  organizationId: string;
  evaluated: number;
  expired: number;
  reactivated: number;
  suppressionsPurged: number;
};

/**
 * `recommendation-lifecycle` (C5, ⊕7) — o job horário de §8.8.
 *
 * Fecha os quatro caminhos de saída de §16.16: expiração por prazo, expiração
 * por premissa resolvida, purga de supressões vencidas e — o que ⊕7 encontrou
 * faltando — **o retorno das diferidas**.
 *
 * Sem o último, `DEFERRED_BY_CONFLICT` é um estado terminal por acidente: a
 * vencedora do conflito é aplicada, o alvo fica livre, e a perdedora continua
 * fora da tela para sempre enquanto o problema que ela descreve segue queimando
 * dinheiro.
 */
@Injectable()
export class RecommendationLifecycleService {
  private readonly logger = new Logger(RecommendationLifecycleService.name);

  constructor(
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly suppressions: SuppressionsRepositoryInterface,
  ) {}

  async execute(input: {
    organizationId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<LifecycleOutcome> {
    const now = input.now ?? new Date();

    const candidates = await this.recommendations.lifecycleCandidates(
      input.organizationId,
    );

    const transitions = decideTransitions(candidates, now);

    if (transitions.length > 0) {
      await this.recommendations.applyTransitions(transitions);
    }

    const suppressionsPurged = await this.suppressions.purgeExpired(now);

    const outcome: LifecycleOutcome = {
      organizationId: input.organizationId,
      evaluated: candidates.length,
      expired: transitions.filter((item) => item.to === 'EXPIRED').length,
      reactivated: transitions.filter((item) => item.to === 'NEW').length,
      suppressionsPurged,
    };

    if (transitions.length > 0 || suppressionsPurged > 0) {
      this.logger.log(
        `recommendation.lifecycle organizationId=${input.organizationId} ` +
          `expiradas=${outcome.expired} reabilitadas=${outcome.reactivated} ` +
          `supressões_purgadas=${suppressionsPurged}`,
      );
    }

    return outcome;
  }
}
