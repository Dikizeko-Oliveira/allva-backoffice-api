import type { ContractDraft } from '../domain/entities';
import type { ContractDraftOutputDto } from './dtos';

export function toContractDraftOutput(
  draft: ContractDraft,
): ContractDraftOutputDto {
  return {
    id: draft.id,
    salesLeadId: draft.salesLeadId,
    terms: draft.terms,
    status: draft.status,
    draftDocumentKey: draft.draftDocumentKey,
    signatureProvider: draft.signatureProvider,
    envelopeId: draft.envelopeId,
    envelopeStatus: draft.envelopeStatus,
    contractId: draft.contractId,
    createdBy: draft.createdBy,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}
