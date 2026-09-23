import { createHash, randomBytes, randomUUID } from 'crypto';

// Any organization role except OWNER can be granted by invitation.
type OrganizationInvitationRole =
  | 'ADMIN'
  | 'FINANCE'
  | 'ANALYST'
  | 'MEMBER'
  | 'VIEWER';

export const INVITATION_EXPIRATION_DAYS = 7;
const INVITATION_TOKEN_BYTES = 32;

type GeneratedInvitationToken = {
  token: string;
  tokenHash: string;
};

type CreateOrganizationInvitationProps = {
  organizationId: string;
  email: string;
  invitedBy: string;
  tokenHash: string;
  role?: OrganizationInvitationRole;
  expiresAt?: Date;
};

type RestoreOrganizationInvitationProps = {
  id: string;
  organizationId: string;
  email: string;
  role: OrganizationInvitationRole;
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  deletedAt?: Date | null;
};

export class OrganizationInvitation {
  private _id: string;
  private _organizationId: string;
  private _email: string;
  private _role: OrganizationInvitationRole;
  private _tokenHash: string;
  private _invitedBy: string;
  private _expiresAt: Date;
  private _acceptedAt: Date | null;
  private _revokedAt: Date | null;
  private _createdAt: Date;
  private _deletedAt: Date | null;

  private constructor(props: RestoreOrganizationInvitationProps) {
    this._id = props.id;
    this._organizationId = props.organizationId;
    this._email = props.email;
    this._role = props.role;
    this._tokenHash = props.tokenHash;
    this._invitedBy = props.invitedBy;
    this._expiresAt = props.expiresAt;
    this._acceptedAt = props.acceptedAt;
    this._revokedAt = props.revokedAt;
    this._createdAt = props.createdAt;
    this._deletedAt = props.deletedAt ?? null;
  }

  /**
   * Generates a cryptographically secure invitation token. The raw token is
   * returned only here (to be sent to the invitee) and is never persisted; only
   * its hash is stored.
   */
  static generateToken(): GeneratedInvitationToken {
    const token = randomBytes(INVITATION_TOKEN_BYTES).toString('base64url');

    return { token, tokenHash: OrganizationInvitation.hashToken(token) };
  }

  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  static create(
    props: CreateOrganizationInvitationProps,
  ): OrganizationInvitation {
    const expiresAt =
      props.expiresAt ??
      new Date(Date.now() + INVITATION_EXPIRATION_DAYS * 24 * 60 * 60 * 1000);

    return new OrganizationInvitation({
      id: randomUUID(),
      organizationId: props.organizationId,
      email: props.email.trim().toLowerCase(),
      role: props.role ?? 'MEMBER',
      tokenHash: props.tokenHash,
      invitedBy: props.invitedBy,
      expiresAt,
      acceptedAt: null,
      revokedAt: null,
      createdAt: new Date(),
      deletedAt: null,
    });
  }

  static restore(
    props: RestoreOrganizationInvitationProps,
  ): OrganizationInvitation {
    return new OrganizationInvitation(props);
  }

  isExpired(reference: Date = new Date()): boolean {
    return this._expiresAt.getTime() <= reference.getTime();
  }

  isAccepted(): boolean {
    return this._acceptedAt !== null;
  }

  isRevoked(): boolean {
    return this._revokedAt !== null;
  }

  isPending(reference: Date = new Date()): boolean {
    return (
      !this.isAccepted() && !this.isRevoked() && !this.isExpired(reference)
    );
  }

  accept(reference: Date = new Date()) {
    this._acceptedAt = reference;
  }

  revoke(reference: Date = new Date()) {
    this._revokedAt = reference;
    // Revoking an invitation is a soft delete: keep the row, stamp deleted_at.
    this._deletedAt = reference;
  }

  isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  get id() {
    return this._id;
  }

  get organizationId() {
    return this._organizationId;
  }

  get email() {
    return this._email;
  }

  get role() {
    return this._role;
  }

  get tokenHash() {
    return this._tokenHash;
  }

  get invitedBy() {
    return this._invitedBy;
  }

  get expiresAt() {
    return this._expiresAt;
  }

  get acceptedAt() {
    return this._acceptedAt;
  }

  get revokedAt() {
    return this._revokedAt;
  }

  get createdAt() {
    return this._createdAt;
  }

  get deletedAt() {
    return this._deletedAt;
  }

  /**
   * Public-facing representation. The token hash is intentionally excluded so
   * it never leaks through API responses.
   */
  toJSON() {
    return {
      id: this._id,
      organizationId: this._organizationId,
      email: this._email,
      role: this._role,
      invitedBy: this._invitedBy,
      expiresAt: this._expiresAt,
      acceptedAt: this._acceptedAt,
      revokedAt: this._revokedAt,
      createdAt: this._createdAt,
    };
  }
}
