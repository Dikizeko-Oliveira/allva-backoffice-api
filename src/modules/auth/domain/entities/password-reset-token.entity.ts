import { randomUUID } from 'crypto';

type CreatePasswordResetTokenProps = {
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
};

type RestorePasswordResetTokenProps = {
  id: string;
  accountId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
};

export class PasswordResetToken {
  private _id: string;
  private _accountId: string;
  private _tokenHash: string;
  private _expiresAt: Date;
  private _usedAt: Date | null;
  private _createdAt: Date;

  private constructor(props: RestorePasswordResetTokenProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._tokenHash = props.tokenHash;
    this._expiresAt = props.expiresAt;
    this._usedAt = props.usedAt;
    this._createdAt = props.createdAt;
  }

  static create(props: CreatePasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken({
      id: randomUUID(),
      accountId: props.accountId,
      tokenHash: props.tokenHash,
      expiresAt: props.expiresAt,
      usedAt: null,
      createdAt: new Date(),
    });
  }

  static restore(props: RestorePasswordResetTokenProps): PasswordResetToken {
    return new PasswordResetToken(props);
  }

  markAsUsed() {
    this._usedAt = new Date();
  }

  isExpired(referenceDate: Date = new Date()): boolean {
    return referenceDate > this._expiresAt;
  }

  isUsed(): boolean {
    return this._usedAt !== null;
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get tokenHash() {
    return this._tokenHash;
  }

  get expiresAt() {
    return this._expiresAt;
  }

  get usedAt() {
    return this._usedAt;
  }

  get createdAt() {
    return this._createdAt;
  }
}
