import { randomUUID } from 'crypto';

type CreateAccountProviderIdentityProps = {
  accountId: string;
  provider: string;
  providerSubject: string;
  email?: string;
};

type RestoreAccountProviderIdentityProps = {
  id: string;
  accountId: string;
  provider: string;
  providerSubject: string;
  email?: string;
  createdAt: Date;
};

export class AccountProviderIdentity {
  private _id: string;
  private _accountId: string;
  private _provider: string;
  private _providerSubject: string;
  private _email?: string;
  private _createdAt: Date;

  private constructor(props: RestoreAccountProviderIdentityProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._provider = props.provider;
    this._providerSubject = props.providerSubject;
    this._email = props.email;
    this._createdAt = props.createdAt;
  }

  static create(props: CreateAccountProviderIdentityProps) {
    return new AccountProviderIdentity({
      id: randomUUID(),
      accountId: props.accountId,
      provider: props.provider,
      providerSubject: props.providerSubject,
      email: props.email,
      createdAt: new Date(),
    });
  }

  static restore(props: RestoreAccountProviderIdentityProps) {
    return new AccountProviderIdentity(props);
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

  get providerSubject() {
    return this._providerSubject;
  }

  get email() {
    return this._email;
  }

  get createdAt() {
    return this._createdAt;
  }
}
