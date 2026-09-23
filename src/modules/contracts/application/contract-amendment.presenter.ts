import { ContractAmendment } from '../domain/entities';
import type { AmendmentUsage } from './services/contract-usage.service';

/** O aditivo como o operador o lê no histórico do contrato. */
export type AmendmentView = {
  id: string;
  number: string;
  contractId: string;
  organizationId: string;
  effectiveAt: string;
  appliedAt: string | null;
  reason: string;
  changes: Record<string, number | null>;
  /** O que havia antes — nulo enquanto o aditivo não foi aplicado. */
  previous: Record<string, number | null>;
  createdBy: string;
  createdAt: string;
  /**
   * O uso de hoje em cada teto que o aditivo mexe.
   *
   * Informativo, e não impeditivo: uma redução datada para janeiro é assinada
   * em setembro porque o cliente vai encolher até lá. O que este campo evita é
   * o operador descobrir depois — sobretudo em `monitoredAds`, que some da
   * análise numa madrugada em vez de recusar um clique.
   */
  usage?: AmendmentUsage;
};

export function toAmendmentView(
  amendment: ContractAmendment,
  usage?: AmendmentUsage,
): AmendmentView {
  return {
    ...(usage ? { usage } : {}),
    id: amendment.id,
    number: amendment.number,
    contractId: amendment.contractId,
    organizationId: amendment.organizationId,
    effectiveAt: amendment.effectiveAt.toISOString(),
    appliedAt: amendment.appliedAt?.toISOString() ?? null,
    reason: amendment.reason,
    changes: amendment.changes,
    previous: amendment.previous,
    createdBy: amendment.createdBy,
    createdAt: amendment.createdAt.toISOString(),
  };
}
