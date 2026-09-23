import { randomUUID } from 'crypto';

type CreatePreferenceProps = {
  accountId: string;
  notificationByEmail?: boolean;
  dailyResume?: boolean;
  alertNotifications?: boolean;
  promotionNotifications?: boolean;
  productNewsNotification?: boolean;
};

type RestorePreferenceProps = {
  id: string;
  accountId: string;
  notificationByEmail: boolean;
  dailyResume: boolean;
  alertNotifications: boolean;
  promotionNotifications: boolean;
  productNewsNotification: boolean;
  createdAt: Date;
  reviewedAt: Date | null;
};

type UpdatePreferenceProps = {
  notificationByEmail?: boolean;
  dailyResume?: boolean;
  alertNotifications?: boolean;
  promotionNotifications?: boolean;
  productNewsNotification?: boolean;
};

export class Preference {
  private _id: string;
  private _accountId: string;
  private _notificationByEmail: boolean;
  private _dailyResume: boolean;
  private _alertNotifications: boolean;
  private _promotionNotifications: boolean;
  private _productNewsNotification: boolean;
  private _createdAt: Date;
  private _reviewedAt: Date | null;

  private constructor(props: RestorePreferenceProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._notificationByEmail = props.notificationByEmail;
    this._dailyResume = props.dailyResume;
    this._alertNotifications = props.alertNotifications;
    this._promotionNotifications = props.promotionNotifications;
    this._productNewsNotification = props.productNewsNotification;
    this._createdAt = props.createdAt;
    this._reviewedAt = props.reviewedAt;
  }

  static create(props: CreatePreferenceProps): Preference {
    return new Preference({
      id: randomUUID(),
      accountId: props.accountId,
      notificationByEmail: props.notificationByEmail ?? true,
      dailyResume: props.dailyResume ?? false,
      alertNotifications: props.alertNotifications ?? true,
      promotionNotifications: props.promotionNotifications ?? true,
      productNewsNotification: props.productNewsNotification ?? true,
      createdAt: new Date(),
      // Nasce sem carimbo: `create` roda no cadastro, nao numa escolha.
      reviewedAt: null,
    });
  }

  static restore(props: RestorePreferenceProps): Preference {
    return new Preference(props);
  }

  /**
   * Salvar a tela **e** o ato que o carimbo registra — por isso ele e escrito
   * aqui, e nao so quando algum valor muda de fato. Um PUT que reenvia os
   * mesmos booleanos e alguem dizendo "conferi, esta certo assim".
   */
  update(props: UpdatePreferenceProps) {
    this._reviewedAt = new Date();

    if (props.notificationByEmail !== undefined)
      this._notificationByEmail = props.notificationByEmail;
    if (props.dailyResume !== undefined) this._dailyResume = props.dailyResume;
    if (props.alertNotifications !== undefined)
      this._alertNotifications = props.alertNotifications;
    if (props.promotionNotifications !== undefined)
      this._promotionNotifications = props.promotionNotifications;
    if (props.productNewsNotification !== undefined)
      this._productNewsNotification = props.productNewsNotification;
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get notificationByEmail() {
    return this._notificationByEmail;
  }

  get dailyResume() {
    return this._dailyResume;
  }

  get alertNotifications() {
    return this._alertNotifications;
  }

  get promotionNotifications() {
    return this._promotionNotifications;
  }

  get productNewsNotification() {
    return this._productNewsNotification;
  }

  get createdAt() {
    return this._createdAt;
  }

  get reviewedAt() {
    return this._reviewedAt;
  }

  /** A tela ja foi salva por um humano pelo menos uma vez. */
  get isReviewed(): boolean {
    return this._reviewedAt !== null;
  }

  toJSON() {
    return {
      id: this._id,
      accountId: this._accountId,
      notificationByEmail: this._notificationByEmail,
      dailyResume: this._dailyResume,
      alertNotifications: this._alertNotifications,
      promotionNotifications: this._promotionNotifications,
      productNewsNotification: this._productNewsNotification,
      createdAt: this._createdAt,
      reviewedAt: this._reviewedAt,
    };
  }
}
