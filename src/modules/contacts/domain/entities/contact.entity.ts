import { randomUUID } from 'crypto';

export const ContactStatusValues = [
  'NEW',
  'READ',
  'REPLIED',
  'ARCHIVED',
] as const;

export type ContactStatus = (typeof ContactStatusValues)[number];

type CreateContactProps = {
  accountId?: string | null;
  name: string;
  email: string;
  subject: string;
  message: string;
  company?: string | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
};

type RestoreContactProps = {
  id: string;
  accountId: string | null;
  name: string;
  email: string;
  subject: string;
  message: string;
  company: string | null;
  status: ContactStatus;
  source: string | null;
  readAt: Date | null;
  repliedAt: Date | null;
  archivedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};

export class Contact {
  private _id: string;
  private _accountId: string | null;
  private _name: string;
  private _email: string;
  private _subject: string;
  private _message: string;
  private _company: string | null;
  private _status: ContactStatus;
  private _source: string | null;
  private _readAt: Date | null;
  private _repliedAt: Date | null;
  private _archivedAt: Date | null;
  private _metadata: Record<string, unknown> | null;
  private _createdAt: Date;
  private _updatedAt: Date;

  private constructor(props: RestoreContactProps) {
    this._id = props.id;
    this._accountId = props.accountId;
    this._name = props.name;
    this._email = props.email;
    this._subject = props.subject;
    this._message = props.message;
    this._company = props.company;
    this._status = props.status;
    this._source = props.source;
    this._readAt = props.readAt;
    this._repliedAt = props.repliedAt;
    this._archivedAt = props.archivedAt;
    this._metadata = props.metadata;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
  }

  static create(props: CreateContactProps): Contact {
    const now = new Date();

    return new Contact({
      id: randomUUID(),
      accountId: props.accountId ?? null,
      name: props.name,
      email: props.email,
      subject: props.subject,
      message: props.message,
      company: props.company ?? null,
      status: 'NEW',
      source: props.source ?? null,
      readAt: null,
      repliedAt: null,
      archivedAt: null,
      metadata: props.metadata ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: RestoreContactProps): Contact {
    return new Contact(props);
  }

  /**
   * Transitions the contact message to a new status, stamping the lifecycle
   * timestamps (read/replied/archived) the first time each milestone is reached.
   * Statuses are free to move in any direction so an operator can re-open an
   * archived or already-replied message if needed.
   */
  changeStatus(next: ContactStatus): void {
    if (this._status === next) {
      return;
    }

    const now = new Date();
    this._status = next;
    this._updatedAt = now;

    if (next === 'READ' && !this._readAt) {
      this._readAt = now;
    }

    if (next === 'REPLIED') {
      this._repliedAt = now;
      // A reply implies the message was read.
      if (!this._readAt) this._readAt = now;
    }

    if (next === 'ARCHIVED' && !this._archivedAt) {
      this._archivedAt = now;
    }
  }

  get id() {
    return this._id;
  }

  get accountId() {
    return this._accountId;
  }

  get name() {
    return this._name;
  }

  get email() {
    return this._email;
  }

  get subject() {
    return this._subject;
  }

  get message() {
    return this._message;
  }

  get company() {
    return this._company;
  }

  get status() {
    return this._status;
  }

  get source() {
    return this._source;
  }

  get readAt() {
    return this._readAt;
  }

  get repliedAt() {
    return this._repliedAt;
  }

  get archivedAt() {
    return this._archivedAt;
  }

  get metadata() {
    return this._metadata;
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
      name: this._name,
      email: this._email,
      subject: this._subject,
      message: this._message,
      company: this._company,
      status: this._status,
      source: this._source,
      readAt: this._readAt,
      repliedAt: this._repliedAt,
      archivedAt: this._archivedAt,
      metadata: this._metadata,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
