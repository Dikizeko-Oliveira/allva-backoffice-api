import { randomUUID } from 'crypto';

type PaymentStatus =
  | 'PENDING'
  | 'APPROVED'
  | 'AUTHORIZED'
  | 'IN_PROCESS'
  | 'IN_MEDIATION'
  | 'REJECTED'
  | 'CANCELED'
  | 'REFUNDED'
  | 'CHARGED_BACK';

type PaymentMethodType = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD';
/**
 * `MANUAL` entrou com a fatura de contrato: a baixa que o operador dá sobre um
 * boleto ou uma transferência é um pagamento tão real quanto o da Stripe — o
 * que muda é quem o processou, não se ele existiu.
 */
type BillingProvider = 'STRIPE' | 'MANUAL';

type CreatePaymentProps = {
  accountId: string;
  subscriptionId: string;
  invoiceId: string;
  provider: BillingProvider;
  amount: number;
  externalReference: string;
  currency?: string;
  metadata?: Record<string, unknown>;
};

type RestorePaymentProps = {
  id: string;
  accountId: string;
  subscriptionId: string;
  invoiceId: string;
  provider: BillingProvider;
  status: PaymentStatus;
  paymentMethod?: PaymentMethodType;
  amount: number;
  currency: string;
  externalReference: string;
  externalPaymentId?: string;
  statusDetail?: string;
  metadata?: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  paidAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export class Payment {
  private _id: string;
  private _accountId: string;
  private _subscriptionId: string;
  private _invoiceId: string;
  private _provider: BillingProvider;
  private _status: PaymentStatus;
  private _paymentMethod?: PaymentMethodType;
  private _amount: number;
  private _currency: string;
  private _externalReference: string;
  private _externalPaymentId?: string;
  private _statusDetail?: string;
  private _metadata?: Record<string, unknown>;
  private _rawResponse?: Record<string, unknown>;
  private _paidAt?: Date;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestorePaymentProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._subscriptionId = props.subscriptionId;
    this._invoiceId = props.invoiceId;
    this._provider = props.provider;
    this._status = props.status;
    this._paymentMethod = props.paymentMethod;
    this._amount = props.amount;
    this._currency = props.currency;
    this._externalReference = props.externalReference;
    this._externalPaymentId = props.externalPaymentId;
    this._statusDetail = props.statusDetail;
    this._metadata = props.metadata;
    this._rawResponse = props.rawResponse;
    this._paidAt = props.paidAt;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreatePaymentProps): Payment {
    const now = new Date();

    return new Payment({
      id: randomUUID(),
      accountId: props.accountId,
      subscriptionId: props.subscriptionId,
      invoiceId: props.invoiceId,
      provider: props.provider,
      status: 'PENDING',
      amount: props.amount,
      currency: props.currency ?? 'BRL',
      externalReference: props.externalReference,
      metadata: props.metadata,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestorePaymentProps): Payment {
    return new Payment(props);
  }

  updateFromProvider(props: {
    status: PaymentStatus;
    statusDetail?: string;
    externalPaymentId?: string;
    paymentMethod?: PaymentMethodType;
    paidAt?: Date;
    rawResponse?: Record<string, unknown>;
  }) {
    this._status = props.status;
    this._statusDetail = props.statusDetail;
    this._externalPaymentId = props.externalPaymentId;
    this._paymentMethod = props.paymentMethod;
    this._paidAt = props.paidAt;
    this._rawResponse = props.rawResponse;
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

  get invoiceId() {
    return this._invoiceId;
  }

  get provider() {
    return this._provider;
  }

  get status() {
    return this._status;
  }

  get paymentMethod() {
    return this._paymentMethod;
  }

  get amount() {
    return this._amount;
  }

  get currency() {
    return this._currency;
  }

  get externalReference() {
    return this._externalReference;
  }

  get externalPaymentId() {
    return this._externalPaymentId;
  }

  get statusDetail() {
    return this._statusDetail;
  }

  get metadata() {
    return this._metadata;
  }

  get rawResponse() {
    return this._rawResponse;
  }

  get paidAt() {
    return this._paidAt;
  }

  get createdAt() {
    return this._createdAt;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  toJSON() {
    return {
      id: this._id,
      accountId: this._accountId,
      subscriptionId: this._subscriptionId,
      invoiceId: this._invoiceId,
      provider: this._provider,
      status: this._status,
      paymentMethod: this._paymentMethod,
      amount: this._amount,
      currency: this._currency,
      externalReference: this._externalReference,
      externalPaymentId: this._externalPaymentId,
      statusDetail: this._statusDetail,
      metadata: this._metadata,
      rawResponse: this._rawResponse,
      paidAt: this._paidAt,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
