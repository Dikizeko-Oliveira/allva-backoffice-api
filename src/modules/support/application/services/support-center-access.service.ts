import { ForbiddenException, Injectable } from '@nestjs/common';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import type { EnforcedFeatureKey } from 'src/modules/plans/domain/plan-entitlements';

/**
 * O portão da Central de suporte (`/account/support/*`).
 *
 * Três leituras a atravessam — listagem, chamado e checklist —, e cada uma
 * repetindo `stateFor` + `planLimitRefusal` é como duas delas passariam a
 * exigir linhas diferentes do catálogo depois do primeiro ajuste.
 *
 * **O portão do frontend é UX; este é a regra.** `SupportLayout` já redireciona
 * quem não é Enterprise, e isso é bom para quem salvou o link — mas um layout
 * não guarda uma rota HTTP. Mesmo raciocínio que `SendSupportMessageUseCase`
 * aplica a `support-email`.
 *
 * A organização vem do contexto autenticado. Sem ela não há escopo para os
 * chamados, e a recusa diz isso em vez de listar o vazio.
 */
@Injectable()
export class SupportCenterAccessService {
  constructor(private readonly planEntitlement: PlanEntitlementService) {}

  /**
   * @param feature Qual linha do catálogo sustenta esta tela.
   *   `support-dedicated-channel` para os chamados, `support-onboarding` para
   *   o checklist — as duas só no Enterprise, e nomeadas separadamente porque
   *   é assim que o catálogo as vende. Se um dia o Profissional comprar uma
   *   das duas, a outra não vai junto por acidente.
   */
  async assert(
    organizationId: string | null,
    feature: EnforcedFeatureKey,
  ): Promise<string> {
    if (!organizationId) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_CONTEXT_REQUIRED',
        message: 'X-Organization-Id header is required for this resource',
      });
    }

    const state = await this.planEntitlement.stateFor({
      organizationId,
      feature,
    });

    if (!state.allowed) throw planLimitRefusal(state);

    return organizationId;
  }
}
