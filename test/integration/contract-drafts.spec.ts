import { ContractDraft } from 'src/modules/contract-drafts/domain/entities';
import { ContractDraftsPrismaRepository } from 'src/modules/contract-drafts/infrastructure/database/prisma/contract-drafts-prisma.repository';
import type { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { connect, truncate } from './support/prisma';

/** GAP-043: a minuta grava a conversão uma vez só, mesmo em paralelo. */
describe('ContractDraftsPrismaRepository.saveConversion', () => {
  let prisma: PrismaService;
  let repository: ContractDraftsPrismaRepository;

  beforeAll(() => {
    prisma = connect();
    repository = new ContractDraftsPrismaRepository(prisma);
  });
  beforeEach(() => truncate(prisma, ['contract_drafts']));
  afterAll(() => prisma.$disconnect());

  it('duas gravações simultâneas: uma vence, a outra sabe que perdeu', async () => {
    const draft = ContractDraft.create({
      salesLeadId: 'lead-1',
      terms: { billingAmount: 48000 },
      createdBy: 'op-1',
    });
    await repository.save(draft);

    const [a, b] = [
      ContractDraft.restore({ ...(await snapshot(draft.id)) }),
      ContractDraft.restore({ ...(await snapshot(draft.id)) }),
    ];
    a.markConverted('contract-1');
    b.markConverted('contract-1');

    const results = await Promise.all([
      repository.saveConversion(a),
      repository.saveConversion(b),
    ]);

    expect([...results].sort()).toEqual([false, true]);
    expect((await repository.findById(draft.id))?.contractId).toBe(
      'contract-1',
    );
  });

  async function snapshot(id: string) {
    const record = await prisma.contractDraft.findUniqueOrThrow({
      where: { id },
    });
    return { ...record, terms: record.terms as unknown };
  }
});
