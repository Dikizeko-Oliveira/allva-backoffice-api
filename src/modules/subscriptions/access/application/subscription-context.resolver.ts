import { Injectable } from '@nestjs/common';
import { SubscriptionsRepositoryInterface } from 'src/modules/subscriptions/domain/ports';
import {
  ACCESS_RANK,
  AccessStatus,
  BillingStatus,
} from 'src/modules/subscriptions/access/domain/access-status';
import {
  BILLING_PAGE_ALLOWED,
  PRODUCT_ACCESS_ALLOWED,
  SUBSCRIPTIONS_PAGE_ALLOWED,
  isAccessAllowed,
} from 'src/modules/subscriptions/access/domain/access-policy';
import {
  resolveContractRedirect,
  resolveDefaultRedirect,
  resolveReasonCode,
} from 'src/modules/subscriptions/access/domain/redirect-paths';
import {
  resolveAccountAccess,
  resolveOrganizationAccess,
} from 'src/modules/subscriptions/access/domain/organization-access';
import {
  OrganizationEntitlementRepositoryInterface,
  OrganizationEntitlementView,
} from 'src/modules/subscriptions/access/domain/ports/organization-entitlement.repository';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

export type SubscriptionContext = {
  provider: 'STRIPE' | null;
  billingStatus: BillingStatus | null;
  accessStatus: AccessStatus;
  planId: string | null;
  planName: string | null;
  planType: string | null;
  subscriptionId: string | null;
  expiresAt: Date | null;
  gracePeriodEndsAt: Date | null;
  canAccessProduct: boolean;
  canAccessSubscriptionsPage: boolean;
  canAccessBillingPage: boolean;
  /**
   * O teste gratuito desta conta já foi consumido?
   *
   * A tela de contratação precisava saber disso e perguntava outra coisa —
   * "existe `subscriptionId`?" —, que respondia "sim" para toda organização,
   * porque toda organização nasce com uma linha. Desde que quem escolhe um plano
   * pago nasce em `PENDING_PAYMENT`, a pergunta antiga esconderia o card do teste
   * de quem nunca o usou: escolheu o Profissional, desistiu do cartão, e perdeu
   * os 14 dias sem nunca tê-los tido.
   *
   * `trialEndsAt` (ou `expiresAt`, no escopo de conta) é o carimbo honesto: só
   * `startTrial`/`createFree` o escrevem, e a promoção a pago não o apaga — quem
   * testou e depois assinou continua tendo testado.
   */
  hasUsedFreeTrial: boolean;
  /**
   * O acesso desta conta vem do teste gratuito, e só dele?
   *
   * É a diferença entre "tem acesso porque pagou" e "tem acesso porque está
   * experimentando", que `accessStatus` sozinho não consegue expressar: os dois
   * são `ALLOWED`. E era essa indistinção que fechava a única porta que importa
   * — `ALLOWED` é lido em todo lugar como "já assinou, então o que resta é
   * **trocar** de plano", e trocar de plano exige uma assinatura de conta que
   * quem está no teste não tem. O resultado era um beco: o checkout da primeira
   * assinatura mandava para a cobrança, e a cobrança mandava de volta.
   *
   * Quem está no teste é exatamente quem ainda vai contratar. Com esta
   * distinção, `canAccessSubscriptionsPage` e o `POST /subscriptions` voltam a
   * responder "sim" para ele.
   */
  onFreeTrial: boolean;
  /**
   * A assinatura de **conta** cujo pagamento ainda não fechou — a que o checkout
   * deve retomar em vez de criar outra.
   *
   * Vem sempre do escopo de conta, e é por isso que existe: `resolve()` devolve
   * o contexto **mais permissivo** entre conta e organização, então um teste
   * gratuito na organização (`ALLOWED`) sombreia por completo uma assinatura de
   * conta em `INCOMPLETE`. A tela de checkout lia esse contexto sombreado,
   * concluía que não havia nada a retomar e tentava criar de novo — recebendo
   * `SUBSCRIPTION_ALREADY_EXISTS` e travando num "Tentar novamente" que falha
   * igual para sempre. Bastava recarregar a página uma vez para não conseguir
   * mais pagar.
   */
  resumableSubscriptionId: string | null;
  /** O plano daquela assinatura — retomar só vale para o plano que está na tela. */
  resumablePlanId: string | null;
  /**
   * A assinatura é governada por um contrato Enterprise.
   *
   * Muda para onde o cliente é mandado e o que a tela oferece, sem mudar o
   * `accessStatus`: um contrato inadimplente fecha o produto igual a uma
   * assinatura vencida, mas o caminho de volta é outro. `/plans/subscriptions`
   * é o checkout de cartão, e oferecer um plano de tabela a quem já paga por
   * contrato mandaria o cliente para uma compra que a própria API recusa.
   *
   * Falso quando o acesso veio da assinatura de conta — aí o autoatendimento é
   * mesmo o caminho, porque é dele que a pessoa está usando.
   */
  managedByContract: boolean;
  redirectPath: string | null;
  reasonCode: string;
  /** Which subscription granted the resolved access. */
  scope: 'ORGANIZATION' | 'ACCOUNT' | 'NONE';
  organizationId: string | null;
};

export type ResolveOptions = {
  /** The organization selected for this request (X-Organization-Id), if any. */
  organizationId?: string | null;
};

@Injectable()
export class SubscriptionContextResolver {
  constructor(
    private readonly subscriptionsRepository: SubscriptionsRepositoryInterface,
    private readonly organizationEntitlementRepository: OrganizationEntitlementRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async resolve(
    accountId: string,
    options?: ResolveOptions,
  ): Promise<SubscriptionContext> {
    const accountContext = await this.resolveAccountContext(accountId);

    if (!this.env.get('ORG_SCOPED_ENTITLEMENT')) {
      return this.withResumableCheckout(accountContext, accountContext);
    }

    const organizationView =
      await this.organizationEntitlementRepository.findEffectiveForAccount(
        accountId,
        options?.organizationId ?? null,
      );

    if (!organizationView) {
      return this.withResumableCheckout(accountContext, accountContext);
    }

    const organizationContext = this.buildOrganizationContext(organizationView);

    // Additive by design: return whichever subscription grants more access, so
    // enabling org-scoping can never revoke access a personal plan already had.
    const effective =
      ACCESS_RANK[organizationContext.accessStatus] >=
      ACCESS_RANK[accountContext.accessStatus]
        ? organizationContext
        : accountContext;

    return this.withResumableCheckout(effective, accountContext);
  }

  /**
   * Os estados em que a assinatura existe e o pagamento ainda não fechou.
   *
   * São os únicos em que a Stripe guarda um client secret a devolver; nos
   * demais, retomar não quer dizer nada.
   */
  private static readonly AWAITING_PAYMENT: ReadonlyArray<BillingStatus> = [
    'PENDING_PAYMENT',
    'PENDING_ACTIVATION',
    'INCOMPLETE',
  ];

  /**
   * Carimba no contexto efetivo o que só a **conta** sabe: existe um checkout
   * pela metade a retomar?
   *
   * Fica fora de `buildContext` porque a resposta não pertence ao escopo que
   * venceu — precisa atravessá-lo. Um teste gratuito na organização é o
   * contexto mais permissivo e, sozinho, afirmaria "não há nada pendente"
   * enquanto a conta tem uma assinatura em `INCOMPLETE` esperando cartão.
   */
  private withResumableCheckout(
    effective: SubscriptionContext,
    accountContext: SubscriptionContext,
  ): SubscriptionContext {
    const resumable =
      accountContext.scope === 'ACCOUNT' &&
      accountContext.provider !== null &&
      accountContext.billingStatus !== null &&
      SubscriptionContextResolver.AWAITING_PAYMENT.includes(
        accountContext.billingStatus,
      );

    return {
      ...effective,
      resumableSubscriptionId: resumable ? accountContext.subscriptionId : null,
      resumablePlanId: resumable ? accountContext.planId : null,
    };
  }

  private async resolveAccountContext(
    accountId: string,
  ): Promise<SubscriptionContext> {
    const subscription =
      await this.subscriptionsRepository.findByAccountId(accountId);

    if (!subscription) {
      return this.buildEmptyContext();
    }

    const billingStatus = subscription.billingStatus;

    // Graça do `PAST_DUE` vencida e FREE expirado fecham na leitura. As duas
    // regras moram em `resolveAccountAccess`, que a varredura dos jobs também
    // usa — uma cópia aqui e outra lá divergiriam na primeira mudança.
    const accessStatus = resolveAccountAccess({
      billingStatus,
      accessStatus: subscription.accessStatus ?? null,
      gracePeriodEndsAt: subscription.gracePeriodEndsAt ?? null,
      planType: subscription.plan?.type ?? null,
      expiresAt: subscription.expiresAt ?? null,
    });

    return this.buildContext({
      provider: subscription.billingProvider ?? null,
      billingStatus,
      accessStatus,
      planId: subscription.planId,
      planName: subscription.plan?.name ?? null,
      planType: subscription.plan?.type ?? null,
      subscriptionId: subscription.id,
      expiresAt: subscription.expiresAt ?? null,
      gracePeriodEndsAt: subscription.gracePeriodEndsAt ?? null,
      scope: 'ACCOUNT',
      organizationId: null,
      // No escopo de conta o teste é o `Subscription.createFree`, e ele é o
      // único que combina plano FREE com data de expiração.
      hasUsedFreeTrial:
        subscription.plan?.type === 'FREE' && Boolean(subscription.expiresAt),
      onFreeTrial:
        subscription.plan?.type === 'FREE' && accessStatus === 'ALLOWED',
    });
  }

  private buildOrganizationContext(
    view: OrganizationEntitlementView,
  ): SubscriptionContext {
    const billingStatus = view.status;

    // Teste vencido e contrato — fora da vigência, suspenso ou inadimplente
    // além da tolerância — são decididos em `resolveOrganizationAccess`, a mesma
    // função que a varredura dos jobs usa. Uma cópia aqui e outra lá é como a
    // tolerância do contrato valeria para a tela e não para o sync.
    const accessStatus = resolveOrganizationAccess({
      status: billingStatus,
      trialEndsAt: view.trialEndsAt,
      contract: view.contract,
    });

    return this.buildContext({
      managedByContract: view.contract !== null,
      // In the Stripe-first model the org subscription only carries the trial /
      // plan gate; paid provider state lives on the account subscription.
      provider: null,
      billingStatus,
      accessStatus,
      planId: view.planId,
      planName: view.planName,
      planType: view.planType,
      subscriptionId: view.organizationSubscriptionId,
      expiresAt: view.trialEndsAt,
      gracePeriodEndsAt: null,
      scope: 'ORGANIZATION',
      organizationId: view.organizationId,
      // Só `startTrial` escreve `trialEndsAt`; `awaitingFirstPayment` e `onPlan`
      // o deixam nulo justamente para dizer que teste nenhum foi consumido.
      hasUsedFreeTrial: view.trialEndsAt !== null,
      onFreeTrial: view.planType === 'FREE' && accessStatus === 'ALLOWED',
    });
  }

  private buildContext(
    base: Omit<
      SubscriptionContext,
      | 'canAccessProduct'
      | 'canAccessSubscriptionsPage'
      | 'canAccessBillingPage'
      | 'redirectPath'
      | 'reasonCode'
      | 'managedByContract'
      // Preenchidos por `withResumableCheckout`, depois de `resolve()` decidir
      // qual escopo venceu — a resposta vem sempre da conta.
      | 'resumableSubscriptionId'
      | 'resumablePlanId'
    > & {
      hasUsedFreeTrial: boolean;
      onFreeTrial: boolean;
      managedByContract?: boolean;
    },
  ): SubscriptionContext {
    const managedByContract = base.managedByContract ?? false;

    return {
      resumableSubscriptionId: null,
      resumablePlanId: null,
      ...base,
      managedByContract,
      canAccessProduct: isAccessAllowed(
        base.accessStatus,
        PRODUCT_ACCESS_ALLOWED,
      ),
      // O teste gratuito entra aqui por fora da tabela de status, e não dentro
      // dela: `ALLOWED` continua significando "não precisa contratar nada" para
      // todos os outros portões — inclusive o do produto, que o teste deve
      // mesmo abrir.
      /**
       * Quem tem contrato nunca abre a vitrine: não há o que contratar sozinho
       * ali, e o `PAYMENT_REQUIRED` de um contrato inadimplente a abriria — o
       * comportamento certo para quem se autoatende, e errado aqui.
       */
      canAccessSubscriptionsPage:
        !managedByContract &&
        (isAccessAllowed(base.accessStatus, SUBSCRIPTIONS_PAGE_ALLOWED) ||
          base.onFreeTrial),
      /**
       * A cobrança abre sempre para quem tem contrato, inclusive com o produto
       * fechado: é onde ele vê a fatura em aberto e o número do acordo para
       * ligar para o comercial. Fechá-la deixaria o cliente sem caminho nenhum
       * de volta.
       */
      canAccessBillingPage:
        managedByContract ||
        isAccessAllowed(base.accessStatus, BILLING_PAGE_ALLOWED),
      redirectPath: managedByContract
        ? resolveContractRedirect(base.accessStatus)
        : resolveDefaultRedirect(base.accessStatus),
      reasonCode: resolveReasonCode(base.accessStatus),
    };
  }

  private buildEmptyContext(): SubscriptionContext {
    return this.buildContext({
      provider: null,
      billingStatus: null,
      accessStatus: 'BLOCKED',
      planId: null,
      planName: null,
      planType: null,
      subscriptionId: null,
      expiresAt: null,
      gracePeriodEndsAt: null,
      scope: 'NONE',
      organizationId: null,
      hasUsedFreeTrial: false,
      onFreeTrial: false,
    });
  }
}
