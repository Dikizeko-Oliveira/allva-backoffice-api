import { randomUUID } from 'crypto';

type CreateSessionProps = {
  accountId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
};

type RestoreSessionProps = {
  id: string;
  accountId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export class Session {
  private _id: string;
  private _accountId: string;
  private _refreshTokenHash: string;
  private _expiresAt: Date;
  private _ipAddress?: string;
  private _userAgent?: string;
  private _revokedAt?: Date | null;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestoreSessionProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._refreshTokenHash = props.refreshTokenHash;
    this._expiresAt = props.expiresAt;
    this._ipAddress = props.ipAddress;
    this._userAgent = props.userAgent;
    this._revokedAt = props.revokedAt ?? null;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreateSessionProps): Session {
    const now = new Date();

    return new Session({
      id: randomUUID(),
      accountId: props.accountId,
      refreshTokenHash: props.refreshTokenHash,
      expiresAt: props.expiresAt,
      ipAddress: props.ipAddress,
      userAgent: props.userAgent,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestoreSessionProps): Session {
    return new Session(props);
  }

  revoke() {
    if (this._revokedAt) return;

    this._revokedAt = new Date();
    this._updatedAt = new Date();
  }

  isExpired(referenceDate: Date = new Date()): boolean {
    return this._expiresAt.getTime() <= referenceDate.getTime();
  }

  isActive(referenceDate: Date = new Date()): boolean {
    return !this._revokedAt && !this.isExpired(referenceDate);
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get refreshTokenHash() {
    return this._refreshTokenHash;
  }

  get expiresAt() {
    return this._expiresAt;
  }

  get ipAddress() {
    return this._ipAddress;
  }

  get userAgent() {
    return this._userAgent;
  }

  get revokedAt() {
    return this._revokedAt;
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
      expiresAt: this._expiresAt,
      ipAddress: this._ipAddress,
      userAgent: this._userAgent,
      revokedAt: this._revokedAt,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
