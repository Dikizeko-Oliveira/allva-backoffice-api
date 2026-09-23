import { randomUUID } from 'crypto';
import { Plan } from 'src/modules/plans/domain/entities';
import {
  InvoiceStatus,
  canTransitionInvoiceStatus,
} from 'src/modules/invoices/domain/invoice-status-policy';

/** Onde o dinheiro entra: no provedor, ou fora dele. */
export type InvoiceProvider = 'STRIPE' | 'MANUAL';

type CreateInvoiceProps = {
  accountId: string;
  /** Nulo na fatura de contrato — o Enterprise não tem assinatura de conta. */
  subscriptionId?: string | null;
  /** O contrato que originou a fatura, quando ela vem de um. */
  contractId?: string | null;
  planId: string;
  provider: InvoiceProvider;
  number: string;
  amount: number;
  currency?: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt?: Date;
  externalReference?: string;
  externalInvoiceId?: string;
};

type RestoreInvoiceProps = {
  id: string;
  accountId: string;
  subscriptionId?: string | null;
  contractId?: string | null;
  planId: string;
  provider: InvoiceProvider;
  amount: number;
  currency: string;
  periodStart: Date;
  periodEnd: Date;
  dueAt?: Date;
  externalReference?: string;
  externalInvoiceId?: string;
  status: InvoiceStatus;
  number: string;
  updatedAt: Date;
  createdAt: Date;
  plan?: Plan;
};

export class Invoice {
  private _id: string;
  private _accountId: string;
  private _subscriptionId?: string | null;
  private _contractId?: string | null;
  private _planId: string;
  private _provider: InvoiceProvider;
  private _amount: number;
  private _currency: string;
  private _periodStart: Date;
  private _periodEnd: Date;
  private _dueAt?: Date;
  private _externalReference?: string;
  private _externalInvoiceId?: string;
  private _status: InvoiceStatus;
  private _number: string;
  private _updatedAt: Date;
  private _createdAt: Date;
  private _plan?: Plan;

  private constructor(props: RestoreInvoiceProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._subscriptionId = props.subscriptionId ?? null;
    this._contractId = props.contractId ?? null;
    this._planId = props.planId;
    this._provider = props.provider;
    this._amount = props.amount;
    this._currency = props.currency;
    this._periodStart = props.periodStart;
    this._periodEnd = props.periodEnd;
    this._dueAt = props.dueAt;
    this._externalReference = props.externalReference;
    this._externalInvoiceId = props.externalInvoiceId;
    this._status = props.status;
    this._number = props.number;
    this._updatedAt = props.updatedAt;
    this._createdAt = props.createdAt;
    this._plan = props.plan;
  }

  static create(props: CreateInvoiceProps): Invoice {
    const now = new Date();
    return new Invoice({
      id: randomUUID(),
      accountId: props.accountId,
      subscriptionId: props.subscriptionId ?? null,
      contractId: props.contractId ?? null,
      planId: props.planId,
      provider: props.provider,
      amount: props.amount,
      currency: props.currency ?? 'BRL',
      periodStart: props.periodStart,
      periodEnd: props.periodEnd,
      dueAt: props.dueAt,
      externalReference: props.externalReference,
      externalInvoiceId: props.externalInvoiceId,
      status: 'PENDING',
      number: props.number,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestoreInvoiceProps): Invoice {
    return new Invoice(props);
  }

  /**
   * A fatura de um contrato Enterprise.
   *
   * Fábrica própria porque as duas cobranças diferem no que **falta**, e não no
   * que têm: aqui não há assinatura de conta nem provedor a consultar. `MANUAL`
   * não é ausência de provedor, é a declaração de que o dinheiro entra por
   * boleto, PIX ou transferência — e que a baixa é um ato humano, não um
   * webhook.
   *
   * `dueAt` chega calculado pela condição de pagamento negociada: é o caso de
   * uso que conhece `paymentTerms`, e a entidade não deve reimplementar a
   * tabela de prazos.
   */
  static forContract(props: {
    accountId: string;
    contractId: string;
    planId: string;
    number: string;
    amount: number;
    currency: string;
    periodStart: Date;
    periodEnd: Date;
    dueAt: Date;
  }): Invoice {
    return Invoice.create({
      accountId: props.accountId,
      contractId: props.contractId,
      subscriptionId: null,
      planId: props.planId,
      provider: 'MANUAL',
      number: props.number,
      amount: props.amount,
      currency: props.currency,
      periodStart: props.periodStart,
      periodEnd: props.periodEnd,
      dueAt: props.dueAt,
    });
  }

  /** A fatura venceu, e quanto tempo faz. */
  isOverdue(now: Date = new Date()): boolean {
    if (this._status !== 'PENDING') return false;
    if (!this._dueAt) return false;

    return now > this._dueAt;
  }

  get contractId() {
    return this._contractId ?? null;
  }

  /** Whether `status` is reachable from the current one. Callers that expose a
   *  status change to the outside world must check this and refuse, rather than
   *  letting `updateStatus` decide what to do about an illegal move. */
  canTransitionTo(status: InvoiceStatus): boolean {
    return canTransitionInvoiceStatus(this._status, status);
  }

  /**
   * Applies a status change, ignoring illegal ones instead of throwing — the
   * entity keeps its invariant either way, and the codebase puts error
   * signalling in the use cases (see `UpdateInvoiceStatusUseCase`, which checks
   * `canTransitionTo` first and answers with a proper HTTP code).
   */
  updateStatus(status: InvoiceStatus) {
    if (!this.canTransitionTo(status)) return;

    this._status = status;
    this._updatedAt = new Date();
  }

  syncExternalInvoice(props: {
    externalInvoiceId?: string;
    dueAt?: Date;
    amount?: number;
    currency?: string;
    periodStart?: Date;
    periodEnd?: Date;
    externalReference?: string;
  }) {
    this._externalInvoiceId =
      props.externalInvoiceId ?? this._externalInvoiceId;
    this._dueAt = props.dueAt ?? this._dueAt;
    this._amount = props.amount ?? this._amount;
    this._currency = props.currency ?? this._currency;
    this._periodStart = props.periodStart ?? this._periodStart;
    this._periodEnd = props.periodEnd ?? this._periodEnd;
    this._externalReference =
      props.externalReference ?? this._externalReference;
    this._updatedAt = new Date();
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get subscriptionId() {
    return this._subscriptionId;
  }

  get planId() {
    return this._planId;
  }

  get number() {
    return this._number;
  }

  get provider() {
    return this._provider;
  }

  get amount() {
    return this._amount;
  }

  get currency() {
    return this._currency;
  }

  get periodStart() {
    return this._periodStart;
  }

  get periodEnd() {
    return this._periodEnd;
  }

  get dueAt() {
    return this._dueAt;
  }

  get externalReference() {
    return this._externalReference;
  }

  get externalInvoiceId() {
    return this._externalInvoiceId;
  }

  get status() {
    return this._status;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  get createdAt() {
    return this._createdAt;
  }

  get plan() {
    return this._plan;
  }

  toJSON() {
    return {
      id: this._id,
      accountId: this._accountId,
      subscriptionId: this._subscriptionId ?? null,
      contractId: this._contractId ?? null,
      planId: this._planId,
      plan: this._plan?.toJSON(),
      status: this._status,
      provider: this._provider,
      amount: this._amount,
      currency: this._currency,
      periodStart: this._periodStart,
      periodEnd: this._periodEnd,
      dueAt: this._dueAt,
      externalReference: this._externalReference,
      externalInvoiceId: this._externalInvoiceId,
      number: this._number,
      updatedAt: this._updatedAt,
      createdAt: this._createdAt,
    };
  }
}
