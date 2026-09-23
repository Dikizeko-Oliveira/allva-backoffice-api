import { randomUUID } from 'crypto';

export type ContractStatus =
  | 'SIGNED'
  | 'PENDING_ACTIVATION'
  | 'ACTIVE'
  | 'SUSPENDED'
  | 'CANCELED'
  | 'EXPIRED'
  | 'RENEWED';

export type ContractBillingInterval = 'ANNUAL' | 'MONTHLY';
export type ContractPaymentTerms = 'UPFRONT' | 'NET_15' | 'NET_30' | 'NET_60';
export type ContractPaymentMethod = 'BOLETO' | 'PIX' | 'TRANSFER' | 'CARD';
export type ContractSuspensionReason = 'NON_PAYMENT' | 'OPERATOR';

/** Os tetos que o contrato negociou. Nulo herda o teto do plano. */
export type NegotiatedLimits = {
  maxSeats: number | null;
  maxAdAccounts: number | null;
  maxMonitoredAds: number | null;
  maxOrganizations: number | null;
  /**
   * O teto **diário** de gasto com IA, em moeda-base — o único desta lista que
   * não conta unidades, e sim dinheiro.
   *
   * ## Por que ele precisou entrar no contrato
   *
   * A coluna ganhou um default de R$ 50/dia para que nenhuma organização
   * ficasse sem parede. O número foi calibrado para o maior plano de
   * autoatendimento, e **não serve a um contrato**: a narrativa noturna sai
   * para todo score novo, e 40.000 anúncios contratados custam R$ 64/noite.
   * Uma organização Enterprise nascendo com o default seria cortada em ~31 mil
   * narrativas na primeira madrugada — 22% da entrega contratada, em silêncio.
   *
   * ## Nulo é **sem teto**, e é o certo aqui
   *
   * Um contrato que ainda não precificou IA não pode ser cortado por um número
   * de autoatendimento. `evaluateBudget` lê nulo como "permite", e o operador
   * grava o número quando a conta estiver fechada — `pnpm ai:cost` dá o dado
   * real depois de uma semana de operação.
   *
   * Derivar por fórmula foi considerado e recusado: embutiria uma constante de
   * custo em reais que apodrece em silêncio no primeiro reajuste de fornecedor.
   */
  llmDailyBudgetBase: number | null;
};

export class ContractTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ContractTransitionError';
  }
}

type ContractProps = {
  id: string;
  contractNumber: string;
  salesLeadId: string;
  organizationId: string | null;
  planId: string;
  status: ContractStatus;
  startsAt: Date;
  endsAt: Date;
  billingInterval: ContractBillingInterval;
  billingAmount: number;
  setupFeeAmount: number | null;
  currency: string;
  paymentTerms: ContractPaymentTerms;
  paymentMethod: ContractPaymentMethod;
  activateOnSignature: boolean;
  gracePeriodDays: number;
  autoRenew: boolean;
  limits: NegotiatedLimits;
  signedAt: Date;
  signedDocumentUrl: string | null;
  activatedAt: Date | null;
  canceledAt: Date | null;
  suspendedAt: Date | null;
  suspendedReason: ContractSuspensionReason | null;
  /** O contrato que este renovou. A cadeia é o histórico comercial. */
  renewedFromId: string | null;
};

/** O que a renovação precisa saber, e o que ela pode renegociar. */
export type RenewProps = {
  contractNumber: string;
  startsAt: Date;
  endsAt: Date;
  signedAt: Date;
  signedDocumentUrl?: string | null;
  billingInterval?: ContractBillingInterval;
  billingAmount?: number;
  currency?: string;
  paymentTerms?: ContractPaymentTerms;
  paymentMethod?: ContractPaymentMethod;
  gracePeriodDays?: number;
  autoRenew?: boolean;
  limits?: NegotiatedLimits;
};

export type CreateContractProps = Omit<
  ContractProps,
  | 'id'
  | 'status'
  | 'organizationId'
  | 'activatedAt'
  | 'canceledAt'
  | 'suspendedAt'
  | 'suspendedReason'
  | 'renewedFromId'
>;

/**
 * O acordo comercial de um cliente Enterprise.
 *
 * ## Nasce em `SIGNED`, e não em rascunho
 *
 * Tudo que acontece antes da assinatura — prospecção, proposta, negociação —
 * já é descrito por `SalesLeadStatus`, que existe e é usado. Modelar
 * `DRAFT`/`NEGOTIATING` aqui criaria um segundo pipeline para o mesmo negócio,
 * e dois pipelines divergem: um deles deixa de ser atualizado, e ninguém sabe
 * qual dos dois responde a verdade.
 *
 * O contrato começa onde o lead termina.
 *
 * ## O que ele decide, e o que ele não decide
 *
 * Ele decide a **vigência** e o **estado comercial**. Não decide sozinho o
 * acesso: um contrato dentro do prazo com fatura vencida há sessenta dias não
 * deveria manter o produto aberto. A saúde de pagamento é a outra dimensão, e
 * mora nas faturas — este agregado expõe `grantsAccess`, que responde apenas
 * pela parte que é dele.
 */
export class EnterpriseContract {
  private constructor(private props: ContractProps) {}

  static create(props: CreateContractProps): EnterpriseContract {
    EnterpriseContract.assertTermsAreValid(props);

    return new EnterpriseContract({
      ...props,
      id: randomUUID(),
      status: 'SIGNED',
      organizationId: null,
      activatedAt: null,
      canceledAt: null,
      suspendedAt: null,
      suspendedReason: null,
      renewedFromId: null,
    });
  }

  static restore(props: ContractProps): EnterpriseContract {
    return new EnterpriseContract(props);
  }

  /**
   * As regras que um contrato precisa satisfazer, valha ele nascendo ou sendo
   * corrigido. Corrigir não pode produzir um contrato que a criação recusaria.
   */
  private static assertTermsAreValid(terms: {
    startsAt: Date;
    endsAt: Date;
    billingAmount: number;
    gracePeriodDays: number;
  }): void {
    if (terms.endsAt <= terms.startsAt) {
      throw new ContractTransitionError(
        'CONTRACT_INVALID_TERM',
        'Contract end date must be after its start date',
      );
    }

    if (terms.billingAmount <= 0) {
      throw new ContractTransitionError(
        'CONTRACT_INVALID_AMOUNT',
        'Contract billing amount must be greater than zero',
      );
    }

    if (terms.gracePeriodDays < 0) {
      throw new ContractTransitionError(
        'CONTRACT_INVALID_GRACE_PERIOD',
        'Contract grace period cannot be negative',
      );
    }
  }

  /**
   * Corrige os termos de um contrato **ainda não ativado**.
   *
   * ## Correção não é aditivo
   *
   * O aditivo cobre o que muda depois que o cliente já está usando o que foi
   * provisionado — ele registra que a mudança foi acordada, quando passa a
   * valer e o que havia antes. Antes da ativação não há nada disso: não há
   * organização, não há cota escrita, e um valor digitado errado é erro de
   * digitação. Abrir um aditivo para consertar dígito encheria o histórico do
   * cliente de documentos que não descrevem acordo nenhum.
   *
   * Sem este caminho o contrato assinado com erro era um beco: `applyAmendment`
   * recusa quem não foi ativado, e a única saída era cancelar e recriar —
   * queimando um número de contrato e deixando um `CANCELED` no histórico de
   * quem nunca desistiu de nada.
   *
   * ## Só `SIGNED`
   *
   * `PENDING_ACTIVATION` já provisionou a organização; o que espera ali é o
   * acesso, não a escrita. Corrigir nesse estado mexeria numa cota que já
   * existe, sem deixar o rastro que o aditivo deixa.
   *
   * **Número, lead e plano ficam de fora.** Eles não são digitação: mudar o
   * plano é vender outra coisa, e mudar o lead é outro cliente. Nos dois casos
   * o certo é um contrato novo, e cancelar este.
   */
  correct(changes: {
    startsAt?: Date;
    endsAt?: Date;
    billingInterval?: ContractBillingInterval;
    billingAmount?: number;
    setupFeeAmount?: number | null;
    currency?: string;
    paymentTerms?: ContractPaymentTerms;
    paymentMethod?: ContractPaymentMethod;
    activateOnSignature?: boolean;
    gracePeriodDays?: number;
    autoRenew?: boolean;
    limits?: NegotiatedLimits;
    signedAt?: Date;
    signedDocumentUrl?: string | null;
  }): void {
    this.assertStatusIn(
      ['SIGNED'],
      'CONTRACT_NOT_CORRECTABLE',
      'Only a contract that has not been activated can be corrected; after activation, amend it',
    );

    const next = {
      ...this.props,
      ...Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined),
      ),
    } as ContractProps;

    EnterpriseContract.assertTermsAreValid(next);

    this.props = next;
  }

  /**
   * Anexa o documento assinado — o PDF que o cliente devolveu.
   *
   * Não é correção de termo: o documento é a prova do que foi combinado, e
   * costuma chegar depois do contrato cadastrado (o comercial registra a
   * assinatura, o PDF volta dias depois pelo e-mail do jurídico do cliente).
   * Por isso anexar vale em **qualquer** estado, até num contrato cancelado,
   * cujo histórico continua precisando da prova.
   *
   * **Trocar é outra conversa.** Antes da ativação, trocar o arquivo é o mesmo
   * que consertar um termo digitado errado — subiu o PDF do cliente errado. Depois
   * dela, o documento já sustenta uma organização provisionada e faturas
   * emitidas; substituí-lo em silêncio apagaria a prova que as justifica. A
   * mudança real do acordo tem caminho próprio, o aditivo.
   */
  attachSignedDocument(url: string): void {
    this.assertSignedDocumentAttachable();
    this.props.signedDocumentUrl = url;
  }

  /**
   * A mesma regra de `attachSignedDocument`, perguntada antes: quem sobe o
   * arquivo precisa da resposta **antes** do upload, para não deixar no bucket
   * um PDF que o contrato vai recusar.
   */
  assertSignedDocumentAttachable(): void {
    if (this.props.signedDocumentUrl && this.props.status !== 'SIGNED') {
      throw new ContractTransitionError(
        'CONTRACT_DOCUMENT_LOCKED',
        `The signed document of an activated contract cannot be replaced (current status: ${this.props.status})`,
      );
    }
  }

  /**
   * Decide o estado que a ativação produz.
   *
   * Com `activateOnSignature`, o acesso abre agora e a fatura corre em paralelo
   * — é como empresa grande compra, pagando por boleto em trinta dias. Sem ele,
   * o contrato fica em `PENDING_ACTIVATION` esperando a primeira baixa.
   *
   * **Não recebe `organizationId`, e a ausência é o desenho.** A organização é
   * criada pelo provisionamento, dentro da transação — o agregado não tem como
   * conhecê-la antes de ela existir, e fingir que tem inverteria a ordem entre
   * decidir e gravar. Quem liga as duas pontas é {@link linkOrganization},
   * chamado com o id que voltou.
   *
   * **Idempotente por status.** Reativar sobre um contrato já ativo não é erro:
   * a cadeia de provisionamento inteira é idempotente, e recusar aqui obrigaria
   * quem chama a distinguir "já estava pronto" de "falhou" pelo código do erro.
   */
  activate(now: Date = new Date()): void {
    if (
      this.props.status === 'ACTIVE' ||
      this.props.status === 'PENDING_ACTIVATION'
    ) {
      return;
    }

    this.assertStatusIn(
      ['SIGNED'],
      'CONTRACT_NOT_ACTIVATABLE',
      'Only a signed contract can be activated',
    );

    this.props.activatedAt = now;
    this.props.status = this.props.activateOnSignature
      ? 'ACTIVE'
      : 'PENDING_ACTIVATION';
  }

  /**
   * Registra a organização que o provisionamento criou ou reusou.
   *
   * Separado de {@link activate} porque acontece depois dela, com um dado que
   * só a escrita conhece. Não sobrescreve: uma organização já ligada é a
   * resposta certa numa reativação, e trocá-la apontaria o contrato para outra
   * fronteira de dado.
   */
  linkOrganization(organizationId: string): void {
    this.props.organizationId ??= organizationId;
  }

  /**
   * A primeira baixa abre o acesso de quem negociou pré-pagamento.
   *
   * Só existe para o caminho `activateOnSignature: false` — nos demais o
   * contrato já entrou em `ACTIVE` na ativação, e a fatura é uma consequência,
   * não uma condição.
   */
  confirmFirstPayment(): void {
    this.assertStatusIn(
      ['PENDING_ACTIVATION'],
      'CONTRACT_NOT_AWAITING_PAYMENT',
      'Only a contract awaiting its first payment can be confirmed',
    );

    this.props.status = 'ACTIVE';
  }

  /**
   * Fecha o acesso sem apagar o contrato.
   *
   * `reason` não é rótulo: é o que decide quem pode reabrir. Ver
   * {@link reactivateOnPayment}.
   */
  suspend(props: { reason: ContractSuspensionReason; now?: Date }): void {
    this.assertStatusIn(
      ['ACTIVE'],
      'CONTRACT_NOT_SUSPENDABLE',
      'Only an active contract can be suspended',
    );

    this.props.status = 'SUSPENDED';
    this.props.suspendedAt = props.now ?? new Date();
    this.props.suspendedReason = props.reason;
  }

  /**
   * O operador reabre — qualquer que tenha sido o motivo.
   *
   * É a contrapartida de {@link reactivateOnPayment}: quem suspendeu por
   * decisão humana é quem desfaz por decisão humana.
   */
  reactivateByOperator(): void {
    this.assertStatusIn(
      ['SUSPENDED'],
      'CONTRACT_NOT_SUSPENDED',
      'Only a suspended contract can be reactivated',
    );

    this.clearSuspension();
  }

  /**
   * A baixa da fatura reabre o que a inadimplência fechou — **e nada mais**.
   *
   * Uma suspensão decidida pelo operador (quebra de contrato, fraude, disputa)
   * não pode ser desfeita por um pagamento entrando. Sem esta separação, o
   * ciclo de cobrança reabriria em silêncio uma conta que alguém fechou de
   * propósito, e ninguém notaria até o cliente estar usando o produto de novo.
   *
   * Devolve se houve reativação, para quem chama saber se algo mudou.
   */
  reactivateOnPayment(): boolean {
    if (this.props.status !== 'SUSPENDED') return false;
    if (this.props.suspendedReason !== 'NON_PAYMENT') return false;

    this.clearSuspension();
    return true;
  }

  /** Encerramento definitivo — por acordo, desistência ou quebra. */
  cancel(now?: Date): void {
    this.assertStatusIn(
      ['SIGNED', 'PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED'],
      'CONTRACT_NOT_CANCELABLE',
      'A contract that already ended cannot be canceled',
    );

    this.props.status = 'CANCELED';
    this.props.canceledAt = now ?? new Date();
  }

  /**
   * A vigência terminou.
   *
   * Fato do calendário, sem autor: só se aplica quando `endsAt` já passou.
   * Recusar antes disso impede que um job com relógio errado encerre um
   * contrato vigente.
   */
  markExpired(now: Date = new Date()): void {
    this.assertStatusIn(
      ['ACTIVE', 'SUSPENDED', 'PENDING_ACTIVATION'],
      'CONTRACT_NOT_EXPIRABLE',
      'Only a live contract can expire',
    );

    if (now < this.props.endsAt) {
      throw new ContractTransitionError(
        'CONTRACT_TERM_NOT_ENDED',
        'Contract term has not ended yet',
      );
    }

    this.props.status = 'EXPIRED';
  }

  /**
   * Reescreve os termos vigentes com o que o aditivo negociou.
   *
   * O aditivo é o documento e o registro do antes; o contrato é onde os termos
   * **em vigor** moram. Sem escrever aqui, ele diria 150 assentos enquanto a
   * organização opera com 250 — as duas casas divergindo, que é o que a
   * vigência única evitou desde o começo.
   *
   * Nulo é *inalterado*, e não "herda o plano" — que é o que nulo significa nos
   * mesmos campos do contrato. Confundir as duas leituras zeraria um teto que a
   * negociação nem tocou.
   *
   * Um contrato **suspenso** aceita aditivo de propósito: renegociar o valor
   * para baixo é justamente o que se faz com um cliente inadimplente, e exigir
   * a reativação antes concederia acesso que a negociação ainda não fechou.
   */
  applyAmendment(changes: {
    billingAmount: number | null;
    maxSeats: number | null;
    maxAdAccounts: number | null;
    maxMonitoredAds: number | null;
    maxOrganizations: number | null;
    llmDailyBudgetBase: number | null;
  }): void {
    this.assertStatusIn(
      ['ACTIVE', 'SUSPENDED', 'PENDING_ACTIVATION'],
      'CONTRACT_NOT_AMENDABLE',
      'Only a live contract can be amended',
    );

    this.props.billingAmount =
      changes.billingAmount ?? this.props.billingAmount;
    this.props.limits = {
      maxSeats: changes.maxSeats ?? this.props.limits.maxSeats,
      maxAdAccounts: changes.maxAdAccounts ?? this.props.limits.maxAdAccounts,
      maxMonitoredAds:
        changes.maxMonitoredAds ?? this.props.limits.maxMonitoredAds,
      maxOrganizations:
        changes.maxOrganizations ?? this.props.limits.maxOrganizations,
      llmDailyBudgetBase:
        changes.llmDailyBudgetBase ?? this.props.limits.llmDailyBudgetBase,
    };
  }

  /**
   * O contrato seguinte, a partir deste.
   *
   * ## O que ela herda, e por quê
   *
   * Tudo que não foi renegociado: plano, lead, tetos, condição de pagamento. A
   * renovação de um cliente que continua igual deveria ser um documento com
   * duas datas novas, e obrigar o operador a redigitar quinze campos é como se
   * inventa divergência entre um contrato e o anterior.
   *
   * **A organização vem junto.** Renovar não provisiona nada — a empresa já é
   * cliente. Deixar o sucessor sem organização faria a ativação dele procurar
   * uma para criar, e a regra de reuso do provisionamento é uma rede de
   * segurança, não um lugar onde se apoiar de propósito.
   *
   * ## O que ela **não** faz
   *
   * Não encerra este contrato. A renovação é assinada meses antes de começar, e
   * marcá-lo `RENEWED` agora o tiraria da leitura de acesso — o cliente que
   * renovou cedo perderia o produto no dia em que assinou. Quem o encerra é o
   * fim da vigência dele, e é `markRenewed` que o faz, chamado quando a virada
   * chega e existe sucessor.
   */
  renewInto(props: RenewProps): EnterpriseContract {
    this.assertStatusIn(
      ['ACTIVE', 'SUSPENDED', 'EXPIRED'],
      'CONTRACT_NOT_RENEWABLE',
      'Only a live or expired contract can be renewed',
    );

    if (!this.props.organizationId) {
      throw new ContractTransitionError(
        'CONTRACT_NOT_ACTIVATED',
        'A contract is renewed after activation: this one has no customer yet',
      );
    }

    if (props.startsAt < this.props.endsAt) {
      /**
       * Vigências sobrepostas dariam dois contratos em vigor ao mesmo tempo, e
       * a pergunta "qual deles cobra este mês?" não teria resposta. Antecipar a
       * troca é um aditivo no atual, não uma renovação.
       */
      throw new ContractTransitionError(
        'CONTRACT_RENEWAL_OVERLAPS',
        'The renewal cannot start before the current term ends',
      );
    }

    const next = EnterpriseContract.create({
      contractNumber: props.contractNumber,
      salesLeadId: this.props.salesLeadId,
      planId: this.props.planId,
      startsAt: props.startsAt,
      endsAt: props.endsAt,
      billingInterval: props.billingInterval ?? this.props.billingInterval,
      billingAmount: props.billingAmount ?? this.props.billingAmount,
      // A implantação não se repete: foi cobrada uma vez, na entrada.
      setupFeeAmount: null,
      currency: props.currency ?? this.props.currency,
      paymentTerms: props.paymentTerms ?? this.props.paymentTerms,
      paymentMethod: props.paymentMethod ?? this.props.paymentMethod,
      // Um cliente que já passou um ano conosco não espera pré-pagamento para
      // continuar: a renovação abre na assinatura.
      activateOnSignature: true,
      gracePeriodDays: props.gracePeriodDays ?? this.props.gracePeriodDays,
      autoRenew: props.autoRenew ?? this.props.autoRenew,
      limits: props.limits ?? { ...this.props.limits },
      signedAt: props.signedAt,
      signedDocumentUrl: props.signedDocumentUrl ?? null,
    });

    next.props.renewedFromId = this.props.id;
    next.props.organizationId = this.props.organizationId;

    return next;
  }

  /** Substituído pelo contrato seguinte, que preserva a cadeia comercial. */
  markRenewed(): void {
    this.assertStatusIn(
      ['ACTIVE', 'EXPIRED'],
      'CONTRACT_NOT_RENEWABLE',
      'Only an active or expired contract can be renewed',
    );

    this.props.status = 'RENEWED';
  }

  /**
   * O contrato, **sozinho**, está concedendo acesso agora?
   *
   * Não é a resposta final: a saúde de pagamento é a outra dimensão, e vive nas
   * faturas. Este método responde só pela parte que é do contrato — estado
   * comercial e janela de vigência —, e quem compõe as duas é o resolver de
   * entitlement.
   */
  grantsAccess(now: Date = new Date()): boolean {
    if (this.props.status !== 'ACTIVE') return false;

    return this.hasStarted(now) && !this.hasEnded(now);
  }

  /**
   * Este contrato e o outro cobrem algum dia em comum?
   *
   * Duas vigências sobrepostas na mesma organização não têm resposta para "qual
   * delas cobra este mês?" — e a cota, que é uma linha só, ficaria com o que o
   * último a ativar escreveu.
   *
   * A borda é aberta de propósito: o sucessor de uma renovação começa **no**
   * dia em que o anterior termina, e é assim que `renewInto` o produz. Contar
   * esse instante como sobreposição impediria toda renovação.
   */
  overlaps(other: { startsAt: Date; endsAt: Date }): boolean {
    return (
      this.props.startsAt < other.endsAt && other.startsAt < this.props.endsAt
    );
  }

  hasStarted(now: Date = new Date()): boolean {
    return now >= this.props.startsAt;
  }

  hasEnded(now: Date = new Date()): boolean {
    return now > this.props.endsAt;
  }

  private clearSuspension(): void {
    this.props.status = 'ACTIVE';
    this.props.suspendedAt = null;
    this.props.suspendedReason = null;
  }

  private assertStatusIn(
    allowed: ContractStatus[],
    code: string,
    message: string,
  ): void {
    if (allowed.includes(this.props.status)) return;

    throw new ContractTransitionError(
      code,
      `${message} (current status: ${this.props.status})`,
    );
  }

  get id() {
    return this.props.id;
  }
  get contractNumber() {
    return this.props.contractNumber;
  }
  get salesLeadId() {
    return this.props.salesLeadId;
  }
  get organizationId() {
    return this.props.organizationId;
  }
  get planId() {
    return this.props.planId;
  }
  get status() {
    return this.props.status;
  }
  get startsAt() {
    return this.props.startsAt;
  }
  get endsAt() {
    return this.props.endsAt;
  }
  get billingInterval() {
    return this.props.billingInterval;
  }
  get billingAmount() {
    return this.props.billingAmount;
  }
  get setupFeeAmount() {
    return this.props.setupFeeAmount;
  }
  get currency() {
    return this.props.currency;
  }
  get paymentTerms() {
    return this.props.paymentTerms;
  }
  get paymentMethod() {
    return this.props.paymentMethod;
  }
  get activateOnSignature() {
    return this.props.activateOnSignature;
  }
  get gracePeriodDays() {
    return this.props.gracePeriodDays;
  }
  get autoRenew() {
    return this.props.autoRenew;
  }
  get limits(): NegotiatedLimits {
    return { ...this.props.limits };
  }
  get signedAt() {
    return this.props.signedAt;
  }
  get signedDocumentUrl() {
    return this.props.signedDocumentUrl;
  }
  get activatedAt() {
    return this.props.activatedAt;
  }
  get canceledAt() {
    return this.props.canceledAt;
  }
  get suspendedAt() {
    return this.props.suspendedAt;
  }
  get renewedFromId() {
    return this.props.renewedFromId;
  }
  get suspendedReason() {
    return this.props.suspendedReason;
  }
}
