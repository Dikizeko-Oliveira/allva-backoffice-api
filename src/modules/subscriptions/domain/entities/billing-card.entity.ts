import { randomUUID } from 'crypto';

type BillingProvider = 'STRIPE';
type PaymentMethodType = 'PIX' | 'CREDIT_CARD' | 'DEBIT_CARD';
type BillingCardStatus = 'ACTIVE' | 'REMOVED';

type CreateBillingCardProps = {
  accountId: string;
  provider: BillingProvider;
  externalCustomerId: string;
  externalCardId: string;
  brand?: string;
  paymentMethod?: PaymentMethodType;
  firstSixDigits?: string;
  lastFourDigits: string;
  expirationMonth: number;
  expirationYear: number;
  issuerName?: string;
  cardholderName?: string;
  isDefault?: boolean;
};

type RestoreBillingCardProps = Omit<CreateBillingCardProps, 'isDefault'> & {
  id: string;
  isDefault: boolean;
  status: BillingCardStatus;
  createdAt: Date;
  updatedAt: Date;
};

export class BillingCard {
  private _id: string;
  private _accountId: string;
  private _provider: BillingProvider;
  private _externalCustomerId: string;
  private _externalCardId: string;
  private _brand?: string;
  private _paymentMethod?: PaymentMethodType;
  private _firstSixDigits?: string;
  private _lastFourDigits: string;
  private _expirationMonth: number;
  private _expirationYear: number;
  private _issuerName?: string;
  private _cardholderName?: string;
  private _status: BillingCardStatus;
  private _isDefault: boolean;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestoreBillingCardProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._provider = props.provider;
    this._externalCustomerId = props.externalCustomerId;
    this._externalCardId = props.externalCardId;
    this._brand = props.brand;
    this._paymentMethod = props.paymentMethod;
    this._firstSixDigits = props.firstSixDigits;
    this._lastFourDigits = props.lastFourDigits;
    this._expirationMonth = props.expirationMonth;
    this._expirationYear = props.expirationYear;
    this._issuerName = props.issuerName;
    this._cardholderName = props.cardholderName;
    this._status = props.status;
    this._isDefault = props.isDefault;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreateBillingCardProps): BillingCard {
    const now = new Date();

    return new BillingCard({
      id: randomUUID(),
      status: 'ACTIVE',
      createdAt: now,
      updatedAt: now,
      isDefault: props.isDefault ?? false,
      ...props,
    });
  }

  static restore(props: RestoreBillingCardProps): BillingCard {
    return new BillingCard(props);
  }

  syncFromProvider(props: {
    brand?: string;
    paymentMethod?: PaymentMethodType;
    firstSixDigits?: string;
    lastFourDigits: string;
    expirationMonth: number;
    expirationYear: number;
    issuerName?: string;
    cardholderName?: string;
    isDefault: boolean;
    status?: BillingCardStatus;
  }) {
    this._brand = props.brand;
    this._paymentMethod = props.paymentMethod;
    this._firstSixDigits = props.firstSixDigits;
    this._lastFourDigits = props.lastFourDigits;
    this._expirationMonth = props.expirationMonth;
    this._expirationYear = props.expirationYear;
    this._issuerName = props.issuerName;
    this._cardholderName = props.cardholderName;
    this._isDefault = props.isDefault;
    this._status = props.status ?? 'ACTIVE';
    this._updatedAt = new Date();
  }

  markRemoved() {
    this._status = 'REMOVED';
    this._isDefault = false;
    this._updatedAt = new Date();
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get provider() {
    return this._provider;
  }

  get externalCustomerId() {
    return this._externalCustomerId;
  }

  get externalCardId() {
    return this._externalCardId;
  }

  get brand() {
    return this._brand;
  }

  get paymentMethod() {
    return this._paymentMethod;
  }

  get firstSixDigits() {
    return this._firstSixDigits;
  }

  get lastFourDigits() {
    return this._lastFourDigits;
  }

  get expirationMonth() {
    return this._expirationMonth;
  }

  get expirationYear() {
    return this._expirationYear;
  }

  get issuerName() {
    return this._issuerName;
  }

  get cardholderName() {
    return this._cardholderName;
  }

  get status() {
    return this._status;
  }

  get isDefault() {
    return this._isDefault;
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
      provider: this._provider,
      externalCustomerId: this._externalCustomerId,
      externalCardId: this._externalCardId,
      brand: this._brand,
      paymentMethod: this._paymentMethod,
      firstSixDigits: this._firstSixDigits,
      lastFourDigits: this._lastFourDigits,
      expirationMonth: this._expirationMonth,
      expirationYear: this._expirationYear,
      issuerName: this._issuerName,
      cardholderName: this._cardholderName,
      status: this._status,
      isDefault: this._isDefault,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
