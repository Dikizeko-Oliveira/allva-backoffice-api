import { randomUUID } from 'crypto';

/** Status que a conversão grava. O resto do ciclo é livre (é da tela). */
export const CONVERTED_DRAFT_STATUS = 'SIGNED';

type ContractDraftProps = {
  id: string;
  salesLeadId: string;
  terms: unknown;
  status: string;
  draftDocumentKey: string | null;
  signatureProvider: string | null;
  envelopeId: string | null;
  envelopeStatus: string | null;
  contractId: string | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
};

type SignatureFields = {
  draftDocumentKey: string | null;
  signatureProvider: string | null;
  envelopeId: string | null;
  envelopeStatus: string | null;
};

export type CreateContractDraftProps = {
  salesLeadId: string;
  terms: unknown;
  createdBy: string;
} & Partial<SignatureFields>;

export type UpdateContractDraftProps = Partial<
  { terms: unknown; status: string } & SignatureFields
>;

/**
 * A minuta pré-assinatura de um contrato Enterprise.
 *
 * Mora aqui, e não no `allva-api`, porque até a assinatura ela é negociação —
 * processo comercial interno. O contrato **de verdade** nasce no produto, na
 * conversão (`POST /api/v1/admin/contracts`), e daí em diante a minuta só
 * guarda o `contractId` que aponta para ele.
 */
export class ContractDraft {
  private constructor(private props: ContractDraftProps) {}

  static create(props: CreateContractDraftProps): ContractDraft {
    const now = new Date();

    return new ContractDraft({
      id: randomUUID(),
      salesLeadId: props.salesLeadId,
      terms: props.terms,
      status: 'DRAFT',
      draftDocumentKey: props.draftDocumentKey ?? null,
      signatureProvider: props.signatureProvider ?? null,
      envelopeId: props.envelopeId ?? null,
      envelopeStatus: props.envelopeStatus ?? null,
      contractId: null,
      createdBy: props.createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: ContractDraftProps): ContractDraft {
    return new ContractDraft(props);
  }

  /** Já virou contrato no produto: a partir daqui, a fonte de verdade é lá. */
  get isConverted(): boolean {
    return this.props.contractId !== null;
  }

  /** `undefined` = não mexer; `null` = limpar. */
  update(patch: UpdateContractDraftProps): void {
    this.props = {
      ...this.props,
      terms: patch.terms !== undefined ? patch.terms : this.props.terms,
      status: patch.status ?? this.props.status,
      draftDocumentKey: pick(
        patch.draftDocumentKey,
        this.props.draftDocumentKey,
      ),
      signatureProvider: pick(
        patch.signatureProvider,
        this.props.signatureProvider,
      ),
      envelopeId: pick(patch.envelopeId, this.props.envelopeId),
      envelopeStatus: pick(patch.envelopeStatus, this.props.envelopeStatus),
      updatedAt: new Date(),
    };
  }

  markConverted(contractId: string): void {
    this.props.contractId = contractId;
    this.props.status = CONVERTED_DRAFT_STATUS;
    this.props.updatedAt = new Date();
  }

  get id(): string {
    return this.props.id;
  }

  get salesLeadId(): string {
    return this.props.salesLeadId;
  }

  get terms(): unknown {
    return this.props.terms;
  }

  get status(): string {
    return this.props.status;
  }

  get draftDocumentKey(): string | null {
    return this.props.draftDocumentKey;
  }

  get signatureProvider(): string | null {
    return this.props.signatureProvider;
  }

  get envelopeId(): string | null {
    return this.props.envelopeId;
  }

  get envelopeStatus(): string | null {
    return this.props.envelopeStatus;
  }

  get contractId(): string | null {
    return this.props.contractId;
  }

  get createdBy(): string {
    return this.props.createdBy;
  }

  get createdAt(): Date {
    return this.props.createdAt;
  }

  get updatedAt(): Date {
    return this.props.updatedAt;
  }
}

function pick<T>(next: T | undefined, current: T): T {
  return next !== undefined ? next : current;
}
