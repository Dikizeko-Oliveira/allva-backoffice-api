import { randomUUID } from 'crypto';

/**
 * O plano que governa a organização — a linha que **toda** organização precisa
 * ter e que só o provisionamento de lead criava.
 *
 * ## Por que esta entidade existe
 *
 * `organization_subscriptions` é a única fonte de
 * `OrganizationPlanPortInterface.findPlanTypeByOrganizationId`, e essa porta é a
 * fonte de **toda** guarda de plano: as dezesseis chaves de
 * `ENFORCED_FEATURE_KEYS`, o teto de assentos, a régua de análise, o piso de
 * histórico. `planAllows` fecha na dúvida — sem plano resolvível, tudo é
 * negado —, e a decisão está certa: deixar passar escrita em mídia paga move
 * dinheiro de alguém.
 *
 * O que estava errado era a premissa de que a dúvida não aconteceria. O
 * comentário de `planAllows` diz que o caso é teórico porque "organização
 * provisionada carrega plano", e ele valia só para a organização provisionada
 * por lead `CLOSED_WON`: `EnterpriseProvisioningService` gravava a linha inline,
 * e nenhum outro caminho de criação gravava. Toda organização self-serve —
 * cadastro, `POST /organizations`, backfill — nascia sem plano, e as dezesseis
 * guardas respondiam "o plano atual não inclui X" para um cliente que tinha
 * plano. Foi assim que vincular uma conta de anúncios da Meta passou a recusar
 * com `PLAN_FEATURE_NOT_INCLUDED`.
 *
 * A cura é de tipo, não de disciplina: `saveWithOwner` passou a exigir a
 * assinatura junto da organização, então a próxima forma de criar organização
 * não compila sem decidir qual é o plano dela.
 */
export type OrganizationSubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PENDING_PAYMENT';

/**
 * A janela do teste quando o plano não a declara.
 *
 * Mesmo valor que `EnterpriseProvisioningService` e `CreateSubscriptionUseCase`
 * já usam pelo mesmo motivo: o FREE **é** o teste, e o anterior — cem anos —
 * reinstalava uma camada gratuita perpétua no dia em que alguém salvasse o
 * plano sem o campo.
 */
export const DEFAULT_TRIAL_DAYS = 14;

type RestoreProps = {
  id: string;
  organizationId: string;
  planId: string;
  status: OrganizationSubscriptionStatus;
  trialStartedAt: Date;
  trialEndsAt: Date | null;
};

export class OrganizationSubscription {
  private _id: string;
  private _organizationId: string;
  private _planId: string;
  private _status: OrganizationSubscriptionStatus;
  private _trialStartedAt: Date;
  private _trialEndsAt: Date | null;

  private constructor(props: RestoreProps) {
    this._id = props.id;
    this._organizationId = props.organizationId;
    this._planId = props.planId;
    this._status = props.status;
    this._trialStartedAt = props.trialStartedAt;
    this._trialEndsAt = props.trialEndsAt;
  }

  /**
   * O teste de 14 dias: o produto inteiro, com o calendário como parede.
   *
   * `TRIALING` mapeia para `ALLOWED` em `mapBillingToAccess`, e é
   * `ExpireOrganizationTrialsUseCase` quem fecha a janela na data —
   * `SubscriptionContextResolver` já trata como `PAYMENT_REQUIRED` a partir de
   * `trialEndsAt`, sem esperar o job.
   */
  static startTrial(props: {
    organizationId: string;
    planId: string;
    /** `plan.trialDays`; nulo cai no padrão. */
    trialDays?: number | null;
    now?: Date;
  }): OrganizationSubscription {
    const now = props.now ?? new Date();
    const days = props.trialDays ?? DEFAULT_TRIAL_DAYS;

    return new OrganizationSubscription({
      id: randomUUID(),
      organizationId: props.organizationId,
      planId: props.planId,
      status: 'TRIALING',
      trialStartedAt: now,
      trialEndsAt: new Date(now.getTime() + days * 24 * 60 * 60 * 1000),
    });
  }

  /**
   * A organização nasce **no plano que a conta já paga** — sem teste e sem data
   * de fim.
   *
   * É o caso do Enterprise multi-organização: quem já tem contrato e cria a
   * segunda carteira não está experimentando nada, e um teste de 14 dias
   * bloquearia no dia 15 uma organização que o cliente está pagando. `ACTIVE`
   * porque o estado de cobrança mora na assinatura de conta — a linha da
   * organização carrega o portão de plano, e só ele.
   *
   * `trialEndsAt` nulo nunca casa com o `lte` de `listExpiredTrials`, então a
   * janela aberta é segura por construção.
   */
  static onPlan(props: {
    organizationId: string;
    planId: string;
    now?: Date;
  }): OrganizationSubscription {
    const now = props.now ?? new Date();

    return new OrganizationSubscription({
      id: randomUUID(),
      organizationId: props.organizationId,
      planId: props.planId,
      status: 'ACTIVE',
      trialStartedAt: now,
      trialEndsAt: null,
    });
  }

  /**
   * Escolheu um plano pago na landing e ainda não pagou.
   *
   * O terceiro estado de nascimento, e o que faltava. A organização nascia
   * sempre em `startTrial`, inclusive para quem tinha acabado de clicar em
   * "Profissional": o teste deixava a conta `ALLOWED`, e `ALLOWED` é o estado em
   * que o produto entende "já assinou, mande para o billing trocar de plano" —
   * então o checkout da primeira assinatura expulsava justamente quem vinha
   * assinar. Sem nenhuma rota para pagar, a conta ficava `TRIALING` para sempre.
   *
   * `PENDING_PAYMENT` mapeia para `PENDING_ACTIVATION` em `mapBillingToAccess`,
   * que é exatamente o que se quer dizer: **sem** acesso ao produto,
   * **com** acesso à tela de contratação, e `POST /subscriptions` liberado.
   *
   * A linha existe desde o cadastro, e não podia não existir: `planAllows` fecha
   * na dúvida quando a organização não tem plano resolvível, e o
   * `syncPlanForOwner` do webhook é um `updateMany` — sem linha para achar, o
   * pagamento confirmado não promoveria organização nenhuma e o cliente pagante
   * ficaria com o produto fechado.
   *
   * `trialEndsAt` nulo é o que diz que **o teste não foi consumido**: quem
   * escolheu o pago e desistir ainda pode pegar os 14 dias.
   */
  static awaitingFirstPayment(props: {
    organizationId: string;
    planId: string;
    now?: Date;
  }): OrganizationSubscription {
    return new OrganizationSubscription({
      id: randomUUID(),
      organizationId: props.organizationId,
      planId: props.planId,
      status: 'PENDING_PAYMENT',
      trialStartedAt: props.now ?? new Date(),
      trialEndsAt: null,
    });
  }

  static restore(props: RestoreProps): OrganizationSubscription {
    return new OrganizationSubscription(props);
  }

  get id() {
    return this._id;
  }

  get organizationId() {
    return this._organizationId;
  }

  get planId() {
    return this._planId;
  }

  get status() {
    return this._status;
  }

  get trialStartedAt() {
    return this._trialStartedAt;
  }

  get trialEndsAt() {
    return this._trialEndsAt;
  }
}
