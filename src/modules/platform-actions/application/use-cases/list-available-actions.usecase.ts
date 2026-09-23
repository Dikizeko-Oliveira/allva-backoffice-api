import { Injectable, NotFoundException } from '@nestjs/common';
import { permissionFor } from 'src/modules/platform-actions/domain/rbac/action-permissions';
import { featureFor } from 'src/modules/platform-actions/domain/rbac/action-plan-entitlements';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { ActionTargetsRepositoryInterface } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * `GET /ads/{id}/actions/available` — §13.3.
 *
 * **Não exige que a escrita esteja ligada.** Com `PLATFORM_ACTIONS_ENABLED`
 * desligada a lista continua respondendo, e cada ação vem com
 * `available: false` e o motivo. Recusar a rota inteira faria a tela não saber
 * distinguir "esta instalação não escreve" de "este anúncio não aceita esta
 * ação" — e as duas pedem telas diferentes.
 */
@Injectable()
export class ListAvailableActionsUseCase {
  constructor(
    private readonly targets: ActionTargetsRepositoryInterface,
    private readonly registry: ActionCapabilityRegistryService,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly env: EnvService,
  ) {}

  async execute(input: { organizationId: string; adId: string }) {
    const target = await this.targets.findTarget({
      organizationId: input.organizationId,
      adId: input.adId,
    });

    if (!target) {
      throw new NotFoundException('Anúncio não encontrado');
    }

    const levels = this.levelsOf(target);
    const inFlight = await this.targets.findInFlightWrites({
      organizationId: input.organizationId,
      targets: levels,
    });

    const actions = this.registry.resolveFor({
      target,
      inFlight,
      permissionFor,
    });

    /**
     * Uma consulta por chave **que as ações de fato usam**, não uma por ação e
     * nem uma por chave aplicável do produto.
     *
     * As treze ações consomem duas chaves; iterar as treze faria treze idas ao
     * banco para responder duas perguntas. Iterar `ENFORCED_FEATURE_KEYS`
     * inteiro faria esta rota consultar o teto de contas de anúncios e o de
     * relatórios — que não têm nada a ver com o que ela responde — e o número de
     * consultas cresceria a cada gate novo do produto.
     */
    const features = [
      ...new Set(actions.map((action) => featureFor(action.type))),
    ];

    const planAllowsFeature = new Map(
      await Promise.all(
        features.map(
          async (feature) =>
            [
              feature,
              await this.planEntitlement.allows({
                organizationId: input.organizationId,
                feature,
              }),
            ] as const,
        ),
      ),
    );

    const writeEnabled = this.env.get('PLATFORM_ACTIONS_ENABLED');
    const dryRunOnly = this.env.get('PLATFORM_ACTIONS_DRY_RUN_ONLY');

    /**
     * P10 — a conta perdeu a credencial, e o anúncio continua existindo.
     *
     * É o quarto portão pelo mesmo motivo dos outros três: até aqui a rota
     * respondia `404` neste caso, e a tela não tinha como distinguir "este
     * anúncio não existe" de "reconecte a integração desta conta". O anúncio,
     * suas métricas e seus achados seguem na tela — só a escrita não sai.
     */
    const accountConnected = target.integrationId !== null;

    return envelope(
      {
        adId: target.adId,
        platform: target.platform,
        /**
         * Os três estados que decidem se **alguma** escrita sai daqui, expostos
         * separados de propósito. Colapsá-los num booleano faria "a organização
         * desligou" e "a instalação ainda não escreve" chegarem à tela como a
         * mesma frase — e só o primeiro tem ação do lado do usuário.
         */
        writeGates: {
          installationEnabled: writeEnabled,
          dryRunOnly,
          organizationActionsEnabled: target.actionsEnabled,
          accountConnected,
        },
        actions: actions.map((action) => {
          /**
           * O plano **rebaixa** a ação, ao contrário do dry-run logo abaixo.
           *
           * A diferença é se existe caminho para o usuário: em dry-run a ação
           * continua disponível e só não escreve ainda; fora do plano, ela não
           * vai acontecer hoje de jeito nenhum. Oferecê-la como disponível seria
           * o botão que só pode dar 403 — e o motivo declarado é o que permite a
           * tela oferecer o upgrade em vez de um erro.
           */
          const includedInPlan =
            planAllowsFeature.get(featureFor(action.type)) ?? false;

          const available = action.available && includedInPlan;

          return {
            ...action,
            available,
            ...(action.available && !includedInPlan
              ? {
                  reason: 'PLAN_LIMITED' as const,
                  detail: 'O plano contratado não inclui esta ação.',
                }
              : {}),
            /**
             * Uma ação disponível numa instalação em dry-run continua disponível
             * — o que muda é o que acontece ao aplicá-la. Rebaixá-la para
             * indisponível aqui esconderia o plano inteiro do usuário durante as
             * duas semanas de observação que RP5 exige.
             */
            executable:
              available &&
              writeEnabled &&
              target.actionsEnabled &&
              accountConnected,
          };
        }),
      },
      {
        /**
         * `asOf` sem `provenance`, e a ausência é a resposta certa: P7 pede
         * procedência em **número derivado**, e não há nenhum aqui. Esta
         * resposta é uma declaração de capacidade cruzada com o estado do alvo;
         * inventar `algoVersion` ou `windowDays` para preencher o campo diria ao
         * cliente que houve um cálculo com janela, que não houve.
         */
        asOf: new Date().toISOString(),
      },
    );
  }

  /** Os alvos possíveis deste anúncio — o que I2 precisa consultar de uma vez. */
  private levelsOf(target: {
    adId: string;
    adSet: { id: string } | null;
    campaign: { id: string };
  }) {
    return [
      { type: 'AD' as const, id: target.adId },
      ...(target.adSet
        ? [{ type: 'AD_SET' as const, id: target.adSet.id }]
        : []),
      { type: 'CAMPAIGN' as const, id: target.campaign.id },
    ];
  }
}
