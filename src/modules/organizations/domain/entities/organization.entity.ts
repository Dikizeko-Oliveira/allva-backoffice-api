import { randomUUID } from 'crypto';

type CreateOrganizationProps = {
  ownerId: string;
  name: string;
  /**
   * `true` quando um humano declarou este nome — o modal do produto, onde ele
   * foi digitado, ou a razão social de um lead fechado. O provisionamento do
   * cadastro omite: lá o nome é derivado da conta, e ninguém o viu ainda.
   */
  nameConfirmed?: boolean;
  cnpj?: string;
  phone?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
};

type RestoreOrganizationProps = {
  id: string;
  ownerId: string;
  name: string;
  nameConfirmedAt?: Date | null;
  cnpj?: string;
  phone?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
  createdAt: Date;
  deletedAt?: Date | null;
};

type UpdateOrganizationProps = {
  name?: string;
  cnpj?: string;
  phone?: string;
  address?: string;
  addressNumber?: string;
  addressComplement?: string;
  addressCity?: string;
};

export class Organization {
  private _id: string;
  private _ownerId: string;
  private _name: string;
  private _cnpj?: string;
  private _phone?: string;
  private _address?: string;
  private _addressNumber?: string;
  private _addressComplement?: string;
  private _addressCity?: string;
  private _createdAt: Date;
  private _deletedAt: Date | null;
  private _nameConfirmedAt: Date | null;

  private constructor(props: RestoreOrganizationProps) {
    this._id = props.id;
    this._ownerId = props.ownerId;
    this._name = props.name;
    this._cnpj = props.cnpj;
    this._phone = props.phone;
    this._address = props.address;
    this._addressNumber = props.addressNumber;
    this._addressComplement = props.addressComplement;
    this._addressCity = props.addressCity;
    this._createdAt = props.createdAt;
    this._deletedAt = props.deletedAt ?? null;
    this._nameConfirmedAt = props.nameConfirmedAt ?? null;
  }

  static create(props: CreateOrganizationProps): Organization {
    const now = new Date();

    return new Organization({
      id: randomUUID(),
      ownerId: props.ownerId,
      name: props.name,
      nameConfirmedAt: props.nameConfirmed ? now : null,
      cnpj: props.cnpj,
      phone: props.phone,
      address: props.address,
      addressNumber: props.addressNumber,
      addressComplement: props.addressComplement,
      addressCity: props.addressCity,
      createdAt: now,
      deletedAt: null,
    });
  }

  static restore(props: RestoreOrganizationProps): Organization {
    return new Organization(props);
  }

  update(props: UpdateOrganizationProps) {
    /**
     * Enviar o nome **é** confirmá-lo, mesmo que o texto não mude.
     *
     * O formulário chega pré-preenchido com o nome atual, então submeter sem
     * editar significa "está bom assim". Exigir mudança para carimbar faria a
     * tela perguntar de novo a quem já respondeu — que é exatamente o incômodo
     * que este campo existe para evitar.
     */
    if (props.name !== undefined) {
      this._name = props.name;
      this._nameConfirmedAt = new Date();
    }
    if (props.cnpj !== undefined) this._cnpj = props.cnpj;
    if (props.phone !== undefined) this._phone = props.phone;
    if (props.address !== undefined) this._address = props.address;
    if (props.addressNumber !== undefined)
      this._addressNumber = props.addressNumber;
    if (props.addressComplement !== undefined)
      this._addressComplement = props.addressComplement;
    if (props.addressCity !== undefined) this._addressCity = props.addressCity;
  }

  /** Soft delete: stamp deleted_at; the row is never physically removed. */
  softDelete(reference: Date = new Date()) {
    this._deletedAt = reference;
  }

  isDeleted(): boolean {
    return this._deletedAt !== null;
  }

  get id() {
    return this._id;
  }

  get ownerId() {
    return this._ownerId;
  }

  get name() {
    return this._name;
  }

  get nameConfirmedAt() {
    return this._nameConfirmedAt;
  }

  /**
   * O nome ainda é o derivado do cadastro, e ninguém o confirmou. A tela de
   * convite lê isto para pedir o rename antes do primeiro envio.
   */
  hasProvisionalName(): boolean {
    return this._nameConfirmedAt === null;
  }

  get cnpj() {
    return this._cnpj;
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

  get createdAt() {
    return this._createdAt;
  }

  get deletedAt() {
    return this._deletedAt;
  }

  toJSON() {
    return {
      id: this._id,
      ownerId: this._ownerId,
      name: this._name,
      cnpj: this._cnpj,
      phone: this._phone,
      address: this._address,
      addressNumber: this._addressNumber,
      addressComplement: this._addressComplement,
      addressCity: this._addressCity,
      createdAt: this._createdAt,
    };
  }
}
