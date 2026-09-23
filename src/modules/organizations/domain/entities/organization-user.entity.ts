import { randomUUID } from 'crypto';
import { OrganizationRole } from '../rbac/roles';

export type OrganizationUserStatus =
  | 'ACTIVE'
  | 'INVITED'
  | 'BLOCKED'
  | 'REMOVED';

type CreateOrganizationUserProps = {
  organizationId: string;
  accountId: string;
  role?: OrganizationRole;
  status?: OrganizationUserStatus;
};

type RestoreOrganizationUserProps = {
  id: string;
  organizationId: string;
  accountId: string;
  status: OrganizationUserStatus;
  frozenAt?: Date | null;
  role: OrganizationRole;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
};

export class OrganizationUser {
  private _id: string;
  private _organizationId: string;
  private _accountId: string;
  private _role: OrganizationRole;
  private _status: OrganizationUserStatus;
  private _frozenAt: Date | null;
  private _createdAt: Date;
  private _updatedAt: Date;
  private _deletedAt: Date | null;

  private constructor(props: RestoreOrganizationUserProps) {
    this._id = props.id;
    this._organizationId = props.organizationId;
    this._accountId = props.accountId;
    this._role = props.role;
    this._status = props.status;
    this._frozenAt = props.frozenAt ?? null;
    this._createdAt = props.createdAt;
    this._updatedAt = props.updatedAt;
    this._deletedAt = props.deletedAt ?? null;
  }

  static create(props: CreateOrganizationUserProps): OrganizationUser {
    const now = new Date();

    return new OrganizationUser({
      id: randomUUID(),
      organizationId: props.organizationId,
      accountId: props.accountId,
      status: props.status ?? 'ACTIVE',
      role: props.role ?? 'MEMBER',
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  static restore(props: RestoreOrganizationUserProps): OrganizationUser {
    return new OrganizationUser(props);
  }

  updateRole(role: OrganizationRole) {
    this._role = role;
    this._updatedAt = new Date();
  }

  updateStatus(status: OrganizationUserStatus) {
    this._status = status;
    this._updatedAt = new Date();
  }

  activate() {
    this.updateStatus('ACTIVE');
    // Reactivation (e.g. re-accepting an invitation) clears the soft-delete mark.
    this._deletedAt = null;
  }

  block() {
    this.updateStatus('BLOCKED');
  }

  remove() {
    this.updateStatus('REMOVED');
    // Soft delete: stamp deleted_at while keeping the row for audit/history.
    this._deletedAt = new Date();
  }

  /**
   * Ativo: `ACTIVE` **e** não congelado pelo teto de assentos do plano.
   *
   * O congelamento entra aqui e não num segundo predicado porque todo caller já
   * pergunta `isActive()` — guard de acesso, resolução de permissão, contagem de
   * assentos. Um predicado paralelo significaria encontrar e atualizar cada um
   * deles, e o que ficasse para trás seria uma porta aberta para quem baixou de
   * plano.
   *
   * Data futura é agendamento: o cliente pagou o período e continua ativo até lá.
   */
  isActive(now: Date = new Date()): boolean {
    return this._status === 'ACTIVE' && !this.isFrozen(now);
  }

  isFrozen(now: Date = new Date()): boolean {
    return this._frozenAt !== null && this._frozenAt <= now;
  }

  freezeAt(at: Date): void {
    this._frozenAt = at;
  }

  unfreeze(): void {
    this._frozenAt = null;
  }

  get frozenAt() {
    return this._frozenAt;
  }

  isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  isOwner(): boolean {
    return this._role === 'OWNER';
  }

  get id() {
    return this._id;
  }

  get organizationId() {
    return this._organizationId;
  }

  get accountId() {
    return this._accountId;
  }

  get role() {
    return this._role;
  }

  get status() {
    return this._status;
  }

  get createdAt() {
    return this._createdAt;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  get deletedAt() {
    return this._deletedAt;
  }

  toJSON() {
    return {
      id: this._id,
      organizationId: this._organizationId,
      accountId: this._accountId,
      role: this._role,
      status: this._status,
      frozenAt: this._frozenAt,
      createdAt: this._createdAt,
      updatedAt: this._updatedAt,
    };
  }
}
