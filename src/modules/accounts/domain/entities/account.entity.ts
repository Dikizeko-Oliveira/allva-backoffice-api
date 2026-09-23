import { randomUUID } from 'crypto';

type CreateAccountProps = {
  name: string;
  email: string;
  selectedPlanId?: string;
  stripeCustomerId?: string;
  cpf?: string;
  role?: string;
  phone?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
  avatarUrl?: string;
  passwordHash: string;
  emailVerified?: boolean;
  platformSuspendedAt?: Date | null;
  platformSuspendedBy?: string | null;
  platformSuspendedReason?: string | null;
};

type RestoreAccountProps = {
  id: string;
  name: string;
  email: string;
  selectedPlanId?: string;
  stripeCustomerId?: string;
  cpf?: string;
  phone?: string;
  role?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
  avatarUrl?: string;
  passwordHash: string;
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  platformSuspendedAt?: Date | null;
  platformSuspendedBy?: string | null;
  platformSuspendedReason?: string | null;
  createdAt: Date;
};

export class Account {
  private _id: string;
  private _name: string;
  private _email: string;
  private _selectedPlanId?: string;
  private _stripeCustomerId?: string;
  private _cpf?: string;
  private _phone?: string;
  private _role?: string;
  private _address?: string;
  private _addressNumber?: string;
  private _addressComplement?: string;
  private _addressCity?: string;
  private _avatarUrl?: string;
  private _passwordHash: string;
  private _emailVerified: boolean;
  private _emailVerifiedAt?: Date | null;
  private _platformSuspendedAt?: Date | null;
  private _platformSuspendedBy?: string | null;
  private _platformSuspendedReason?: string | null;
  private _createdAt: Date;

  private constructor(props: RestoreAccountProps) {
    this._id = props.id;
    this._name = props.name;
    this._email = props.email;
    this._selectedPlanId = props.selectedPlanId;
    this._stripeCustomerId = props.stripeCustomerId;
    this._cpf = props.cpf;
    this._phone = props.phone;
    this._role = props.role;
    this._address = props.address;
    this._addressNumber = props.addressNumber;
    this._addressComplement = props.addressComplement;
    this._addressCity = props.addressCity;
    this._avatarUrl = props.avatarUrl;
    this._passwordHash = props.passwordHash;
    this._emailVerified = props.emailVerified ?? false;
    this._emailVerifiedAt = props.emailVerifiedAt ?? null;
    this._platformSuspendedAt = props.platformSuspendedAt ?? null;
    this._platformSuspendedBy = props.platformSuspendedBy ?? null;
    this._platformSuspendedReason = props.platformSuspendedReason ?? null;
    this._createdAt = props.createdAt;
  }

  static create(props: CreateAccountProps): Account {
    return new Account({
      id: randomUUID(),
      name: props.name,
      email: props.email,
      selectedPlanId: props.selectedPlanId,
      stripeCustomerId: props.stripeCustomerId,
      cpf: props.cpf,
      phone: props.phone,
      role: props.role,
      address: props.address,
      addressNumber: props.addressNumber,
      addressComplement: props.addressComplement,
      addressCity: props.addressCity,
      avatarUrl: props.avatarUrl,
      passwordHash: props.passwordHash,
      emailVerified: props.emailVerified ?? false,
      emailVerifiedAt: props.emailVerified ? new Date() : null,
      platformSuspendedAt: props.platformSuspendedAt ?? null,
      platformSuspendedBy: props.platformSuspendedBy ?? null,
      platformSuspendedReason: props.platformSuspendedReason ?? null,
      createdAt: new Date(),
    });
  }

  static restore(props: RestoreAccountProps): Account {
    return new Account(props);
  }

  get id() {
    return this._id;
  }

  get name() {
    return this._name;
  }

  get email() {
    return this._email;
  }

  get stripeCustomerId() {
    return this._stripeCustomerId;
  }

  get selectedPlanId() {
    return this._selectedPlanId;
  }

  get cpf() {
    return this._cpf;
  }

  get phone() {
    return this._phone;
  }

  get address() {
    return this._address;
  }

  get addressNumber() {
    return this._addressNumber;
  }

  get addressComplement() {
    return this._addressComplement;
  }

  get addressCity() {
    return this._addressCity;
  }

  get avatarUrl() {
    return this._avatarUrl;
  }

  get role() {
    return this._role;
  }

  get passwordHash() {
    return this._passwordHash;
  }

  get emailVerified() {
    return this._emailVerified;
  }

  get emailVerifiedAt() {
    return this._emailVerifiedAt ?? null;
  }

  get platformSuspendedAt() {
    return this._platformSuspendedAt ?? null;
  }

  get platformSuspendedBy() {
    return this._platformSuspendedBy ?? null;
  }

  get platformSuspendedReason() {
    return this._platformSuspendedReason ?? null;
  }

  get createdAt() {
    return this._createdAt;
  }

  /** Idempotent: re-verifying keeps the original verification timestamp. */
  markEmailVerified() {
    if (this._emailVerified) return;
    this._emailVerified = true;
    this._emailVerifiedAt = new Date();
  }

  isPlatformSuspended() {
    return (
      this._platformSuspendedAt !== null &&
      this._platformSuspendedAt !== undefined
    );
  }

  attachStripeCustomer(customerId: string) {
    this._stripeCustomerId = customerId;
  }

  toJSON() {
    return {
      id: this._id,
      name: this._name,
      email: this._email,
      selectedPlanId: this._selectedPlanId,
      cpf: this._cpf,
      phone: this._phone,
      // Sem `role`: é papel de **plataforma** (`USER` ou `ALLVA_*`), e este
      // perfil é lido pelo app do cliente. Permissão de cliente vem do
      // `/auth/me`, pela participação na organização.
      address: this._address,
      addressNumber: this._addressNumber,
      addressComplement: this._addressComplement,
      addressCity: this._addressCity,
      avatarUrl: this._avatarUrl,
      emailVerified: this._emailVerified,
      createdAt: this._createdAt,
    };
  }
}
