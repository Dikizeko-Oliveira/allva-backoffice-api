import { Injectable } from '@nestjs/common';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { Plan } from 'src/modules/plans/domain/entities';
import {
  OrganizationContractView,
  OrganizationEntitlementRepositoryInterface,
  OrganizationEntitlementView,
} from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';

/**
 * O contrato como a tela de cobrança do cliente o mostra.
 *
 * Presente **é** o sinal de que a assinatura não se altera por aqui: quem tem
 * contrato negocia com o comercial, e `POST /billing/subscription/change`
 * recusaria de qualquer forma. A tela lê este campo para não oferecer um botão
 * que leva a um erro.
 */
type ContractSummary = {
  id: string;
  number: string;
  status: string;
  startsAt: Date;
  endsAt: Date;
  billingInterval: string;
  paymentTerms: string;
  paymentMethod: string;
  autoRenew: boolean;
};

type ListSubscriptionsResponse = {
  hasSubscription: boolean;
  subscription: {
    id: string;
    planId: string;
    planType?: string;
    planName?: string;
    status: string;
    billingProvider?: string;
    startedAt: Date;
    expiresAt: Date;
    nextBillingAt?: Date;
  } | null;
  /**
   * A vitrine de planos pagos - **sempre presente**, com ou sem assinatura.
   *
   * Era devolvida só no ramo com assinatura, e a consequência caía exatamente
   * do lado errado: quem ainda não contratou nada é justamente quem precisa ver
   * o que dá para contratar. A tela de billing monta a grade a partir daqui, e
   * para essas contas ela chegava vazia - uma página de cobrança sem nada a
   * oferecer para quem só queria assinar.
   */
  plans: Plan[];
  contract?: ContractSummary;
  message?: string;
};
@Injectable()
export class ListSubscriptionsUseCase {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly organizationEntitlement: OrganizationEntitlementRepositoryInterface,
  ) {}

  async execute(accountId: string): Promise<ListSubscriptionsResponse> {
    const [subscription, plans] = await Promise.all([
      this.subscriptionsRepository.findByAccountId(accountId),
      this.plansRepository.listAll(),
    ]);

    // O FREE fica de fora da vitrine dos dois lados: ele não se contrata por
    // aqui, e `POST /billing/subscription/change` recusa com
    // `FREE_CHANGE_NOT_ALLOWED` quem tentar.
    const filteredPlans = plans.filter((plan) => plan.type !== 'FREE');

    if (!subscription) {
      /**
       * Sem assinatura de conta ainda pode haver contrato.
       *
       * Uma organização Enterprise é provisionada com `OrganizationSubscription`
       * e contrato, e **nenhuma** `Subscription` de conta — não há cartão nem
       * Stripe no caminho. Sem esta checagem o cliente que assinou um contrato
       * anual via a mesma tela de quem nunca contratou nada: "você não tem
       * assinatura" e uma vitrine de planos para escolher.
       *
       * A consulta só acontece neste ramo. Quem tem assinatura de conta é a
       * esmagadora maioria e não paga por uma busca que não usa.
       */
      const entitlement =
        await this.organizationEntitlement.findEffectiveForAccount(accountId);

      if (entitlement?.contract) {
        return this.describeContract(entitlement, entitlement.contract);
      }

      return {
        hasSubscription: false,
        subscription: null,
        plans: filteredPlans,
        message: 'User does not have an active subscription',
      };
    }

    return {
      hasSubscription: true,
      subscription: {
        id: subscription.id,
        planId: subscription.planId,
        planType: subscription.plan?.type,
        planName: subscription.plan?.name,
        status: subscription.status,
        billingProvider: subscription.billingProvider,
        startedAt: subscription.startedAt,
        expiresAt: subscription.expiresAt,
        nextBillingAt: subscription.nextBillingAt,
      },
      plans: filteredPlans,
    };
  }

  /**
   * A resposta de quem é governado por contrato.
   *
   * `plans` sai vazia de propósito, e não com a vitrine filtrada: oferecer
   * planos de autoatendimento a quem tem acordo negociado convidaria a uma
   * troca que o produto recusa — e faria a tela mostrar um preço de tabela ao
   * lado de um contrato que foi fechado por outro.
   */
  private describeContract(
    entitlement: OrganizationEntitlementView,
    contract: OrganizationContractView,
  ): ListSubscriptionsResponse {
    return {
      hasSubscription: true,
      /**
       * A assinatura da organização, e não uma da conta — mas assinatura de
       * verdade, com o plano que o contrato ancorou. As datas vêm do contrato
       * porque é lá que a vigência mora: a `OrganizationSubscription` nasce
       * `ACTIVE` e sem prazo justamente para não duplicá-la.
       */
      subscription: {
        id: entitlement.organizationSubscriptionId,
        planId: entitlement.planId,
        planType: entitlement.planType ?? undefined,
        planName: entitlement.planName ?? undefined,
        status: entitlement.status,
        startedAt: contract.startsAt,
        expiresAt: contract.endsAt,
      },
      plans: [],
      contract: {
        id: contract.id,
        number: contract.contractNumber,
        status: contract.status,
        startsAt: contract.startsAt,
        endsAt: contract.endsAt,
        billingInterval: contract.billingInterval,
        paymentTerms: contract.paymentTerms,
        paymentMethod: contract.paymentMethod,
        autoRenew: contract.autoRenew,
      },
    };
  }
}
