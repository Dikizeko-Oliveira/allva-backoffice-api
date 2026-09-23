import { EnterpriseContract } from '../domain/entities';
import { ContractOutputDto } from './dtos/contract.dto';
import { EnterpriseContractsRepositoryInterface } from '../domain/ports/enterprise-contracts.repository';

/** A serialização do contrato, num lugar só — as três rotas devolvem o mesmo. */
export function toContractOutput(
  contract: EnterpriseContract,
): ContractOutputDto {
  return {
    id: contract.id,
    contractNumber: contract.contractNumber,
    salesLeadId: contract.salesLeadId,
    organizationId: contract.organizationId,
    planId: contract.planId,
    status: contract.status,
    startsAt: contract.startsAt.toISOString(),
    endsAt: contract.endsAt.toISOString(),
    billingInterval: contract.billingInterval,
    billingAmount: contract.billingAmount,
    setupFeeAmount: contract.setupFeeAmount,
    currency: contract.currency,
    paymentTerms: contract.paymentTerms,
    paymentMethod: contract.paymentMethod,
    activateOnSignature: contract.activateOnSignature,
    gracePeriodDays: contract.gracePeriodDays,
    autoRenew: contract.autoRenew,
    maxSeats: contract.limits.maxSeats,
    maxAdAccounts: contract.limits.maxAdAccounts,
    maxMonitoredAds: contract.limits.maxMonitoredAds,
    maxOrganizations: contract.limits.maxOrganizations,
    signedAt: contract.signedAt.toISOString(),
    signedDocumentUrl: contract.signedDocumentUrl,
    activatedAt: contract.activatedAt?.toISOString() ?? null,
    suspendedAt: contract.suspendedAt?.toISOString() ?? null,
    suspendedReason: contract.suspendedReason,
    renewedFromId: contract.renewedFromId,
    canceledAt: contract.canceledAt?.toISOString() ?? null,
    llmDailyBudgetBase: contract.limits.llmDailyBudgetBase,
  };
}

/**
 * Lista e detalhe levam os nomes que a tela mostra (empresa do lead,
 * organização, plano) — ver `EnterpriseContractsRepositoryInterface.findLabels`.
 */
export async function withLabels(
  contracts: EnterpriseContract[],
  repository: EnterpriseContractsRepositoryInterface,
): Promise<ContractOutputDto[]> {
  const labels = await repository.findLabels(contracts.map((c) => c.id));

  return contracts.map((contract) => {
    const label = labels.get(contract.id);
    return {
      ...toContractOutput(contract),
      ...(label && { ...label, createdAt: label.createdAt.toISOString() }),
    };
  });
}
