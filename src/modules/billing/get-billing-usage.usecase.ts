import { Injectable } from '@nestjs/common';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import {
  UsageSnapshotService,
  type UsageDimension,
} from './usage-snapshot.service';

/**
 * O consumo do ciclo — **só dimensões, sem par de capa**.
 *
 * Havia `used` e `limit` no topo, herdados de quando a resposta media uma coisa
 * só. Eles apontavam para os achados da madrugada, que saíram: eram resultado do
 * produto e não consumo do plano, e viviam na tela errada. Mantê-los como
 * "resumo" exigiria eleger uma das três dimensões como a principal, e nenhuma é
 * — somar cotas de unidades diferentes produziria um número que não descreve
 * nada.
 */
export type BillingUsage = {
  dimensions: UsageDimension[];
};

/**
 * `GET /api/v1/billing/usage` — o consumo do ciclo corrente.
 *
 * Resolve **quem** está perguntando (conta ou organização) e **sob qual plano**;
 * o que se mede em cada dimensão é de `UsageSnapshotService`.
 *
 * O teto vinha de um `PLAN_ANALYSIS_LIMITS` local, paralelo ao catálogo. Ele
 * sobreviveu porque as duas listas concordavam por acaso, e o Enterprise
 * mostrava `9999` fixo: o cliente que negociou um número em contrato abria a
 * tela feita para conferir o contrato e lia outro. Agora todo teto sai de
 * `PlanEntitlementService`, que é quem as guardas consultam.
 */
@Injectable()
export class GetBillingUsageUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly scope: OwnerScopeResolverService,
    private readonly snapshot: UsageSnapshotService,
  ) {}

  async execute(
    accountId: string,
    now: Date = new Date(),
  ): Promise<BillingUsage> {
    const [subscription, owner] = await Promise.all([
      this.subscriptionsRepository.findByAccountId(accountId),
      this.scope.resolveForAccount(accountId),
    ]);

    // Sem assinatura o plano é desconhecido, não FREE. Assumir FREE aqui
    // concederia o teto do teste a quem não contratou nada, desde que o teste
    // passou a espelhar o PRO.
    const planType = (subscription?.plan?.type ?? null) as PlanType | null;

    return {
      dimensions: await this.snapshot.dimensionsFor(owner, planType, now),
    };
  }
}
