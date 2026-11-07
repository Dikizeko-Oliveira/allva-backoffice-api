import { Operator } from 'src/modules/auth/domain/entities';
import { ContractDraft } from 'src/modules/contract-drafts/domain/entities';
import {
  contractDraftIdempotencyKey,
  ConvertContractDraftUseCase,
} from './convert-contract-draft.usecase';

const operator = Operator.restore({
  id: 'op-1',
  name: 'Ana',
  email: 'ana@allva.com',
  platformRole: 'ALLVA_FINANCE',
  permissions: ['billing:manage'],
  accessToken: 'token',
});

/**
 * Um repositório em memória com a gravação condicional do banco
 * (`WHERE contract_id IS NULL`) e um produto que, como o `allva-api`, devolve o
 * mesmo contrato à mesma `Idempotency-Key`.
 */
function build() {
  const draft = ContractDraft.create({
    salesLeadId: 'lead-1',
    terms: { billingAmount: 48000 },
    createdBy: 'op-1',
  });
  let stored = ContractDraft.restore({ ...snapshot(draft) });

  const draftsRepository = {
    findById: jest.fn(async () => ContractDraft.restore(snapshot(stored))),
    saveConversion: jest.fn(async (next: ContractDraft) => {
      if (stored.contractId !== null) return false;
      stored = ContractDraft.restore(snapshot(next));
      return true;
    }),
  };

  const contractsByKey = new Map<string, string>();
  const productContracts = {
    create: jest.fn(async (_op: Operator, _terms: unknown, key: string) => {
      // Cede a vez: é o intervalo em que as duas conversões se cruzam.
      await new Promise((resolve) => setImmediate(resolve));
      if (!contractsByKey.has(key)) {
        contractsByKey.set(key, `contract-${contractsByKey.size + 1}`);
      }
      return { contractId: contractsByKey.get(key)! };
    }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new ConvertContractDraftUseCase(
    draftsRepository as never,
    productContracts as never,
    audit as never,
  );

  return {
    useCase,
    draft,
    productContracts,
    audit,
    contractsByKey,
    draftsRepository,
  };
}

function snapshot(draft: ContractDraft) {
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

/** GAP-043: uma minuta vira no máximo um contrato. */
describe('ConvertContractDraftUseCase', () => {
  it('pede o contrato com a chave derivada da minuta', async () => {
    const { useCase, draft, productContracts } = build();

    await useCase.execute(operator, draft.id);

    expect(productContracts.create).toHaveBeenCalledWith(
      operator,
      draft.terms,
      contractDraftIdempotencyKey(draft.id),
    );
  });

  it('duas conversões simultâneas: um contrato, uma auditoria', async () => {
    const { useCase, draft, audit, contractsByKey } = build();

    const [a, b] = await Promise.all([
      useCase.execute(operator, draft.id),
      useCase.execute(operator, draft.id),
    ]);

    expect(contractsByKey.size).toBe(1);
    expect(a.contractId).toBe('contract-1');
    expect(b.contractId).toBe('contract-1');
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('nova tentativa depois de falha local devolve o mesmo contrato', async () => {
    const { useCase, draft, draftsRepository, contractsByKey } = build();

    draftsRepository.saveConversion.mockRejectedValueOnce(
      new Error('banco fora'),
    );
    await expect(useCase.execute(operator, draft.id)).rejects.toThrow(
      'banco fora',
    );

    const retry = await useCase.execute(operator, draft.id);

    expect(retry.contractId).toBe('contract-1');
    expect(contractsByKey.size).toBe(1);
  });

  it('minuta já convertida não chama o produto de novo', async () => {
    const { useCase, draft, productContracts } = build();

    await useCase.execute(operator, draft.id);
    await useCase.execute(operator, draft.id);

    expect(productContracts.create).toHaveBeenCalledTimes(1);
  });
});
