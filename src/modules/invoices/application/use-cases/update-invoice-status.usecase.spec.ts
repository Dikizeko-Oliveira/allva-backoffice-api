import { ConflictException, ForbiddenException } from '@nestjs/common';
import { UpdateInvoiceStatusUseCase } from './update-invoice-status.usecase';
import { Invoice } from 'src/modules/invoices/domain/entities';
import { InvoiceStatus } from 'src/modules/invoices/domain/invoice-status-policy';

const OWNER_ID = 'acc-owner';

function buildInvoice(status: InvoiceStatus = 'PENDING') {
  const invoice = Invoice.create({
    accountId: OWNER_ID,
    subscriptionId: 'sub-1',
    planId: 'plan-1',
    provider: 'STRIPE',
    number: 'INV-0001',
    amount: 199.9,
    periodStart: new Date('2026-07-01'),
    periodEnd: new Date('2026-08-01'),
  });

  invoice.updateStatus(status);

  return invoice;
}

function buildHarness(options?: {
  actorRole?: string;
  actorId?: string;
  invoice?: Invoice | null;
}) {
  const actorId = options?.actorId ?? 'acc-operator';
  const invoice =
    options?.invoice === undefined ? buildInvoice() : options.invoice;

  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({
      id: actorId,
      role: options?.actorRole ?? 'ALLVA_FINANCE',
    }),
  };
  const invoicesRepository = {
    findById: jest.fn().mockResolvedValue(invoice),
    updateStatus: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new UpdateInvoiceStatusUseCase(
    invoicesRepository as never,
    accountsRepository as never,
    auditLog as never,
  );

  return { useCase, invoicesRepository, accountsRepository, auditLog, actorId };
}

describe('UpdateInvoiceStatusUseCase', () => {
  /**
   * THE FIX. This endpoint used to authorize on `isOperator || isOwner`, so the
   * account an invoice belonged to could `PUT` its own pending invoice straight
   * to PAID — writing a settled financial record for a charge that never
   * happened. `CreateInvoiceUseCase` was already operator-only; the asymmetry
   * was the bug.
   */
  it('refuses the invoice owner', async () => {
    const h = buildHarness({ actorId: OWNER_ID, actorRole: 'USER' });

    await expect(
      h.useCase.execute('inv-1', { status: 'PAID' }, OWNER_ID),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(h.invoicesRepository.updateStatus).not.toHaveBeenCalled();
  });

  it.each(['ALLVA_FINANCE', 'ALLVA_ADMIN'])('allows %s', async (role) => {
    const h = buildHarness({ actorRole: role });

    await h.useCase.execute('inv-1', { status: 'PAID' }, h.actorId);

    expect(h.invoicesRepository.updateStatus).toHaveBeenCalledTimes(1);
  });

  /**
   * B13: com a guarda binária qualquer conta interna corrigia registro
   * financeiro. Agora é `billing:manage` — financeiro e administração.
   */
  it.each(['ALLVA_OPERATOR', 'ALLVA_SUPPORT', 'ALLVA_SALES'])(
    'refuses %s — no billing:manage',
    async (role) => {
      const h = buildHarness({ actorRole: role });

      await expect(
        h.useCase.execute('inv-1', { status: 'PAID' }, h.actorId),
      ).rejects.toBeInstanceOf(ForbiddenException);

      expect(h.invoicesRepository.updateStatus).not.toHaveBeenCalled();
    },
  );

  it('rejects an illegal transition with 409 instead of writing it', async () => {
    const h = buildHarness({ invoice: buildInvoice('PAID') });

    await expect(
      h.useCase.execute('inv-1', { status: 'PENDING' }, h.actorId),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(h.invoicesRepository.updateStatus).not.toHaveBeenCalled();
  });

  it('records who changed what', async () => {
    const h = buildHarness();

    await h.useCase.execute('inv-1', { status: 'PAID' }, h.actorId);

    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'invoice.status_changed',
        entityType: 'invoice',
        actorId: h.actorId,
        metadata: expect.objectContaining({ from: 'PENDING', to: 'PAID' }),
      }),
    );
  });

  it('short-circuits a repeat without writing or auditing', async () => {
    const h = buildHarness({ invoice: buildInvoice('PAID') });

    await h.useCase.execute('inv-1', { status: 'PAID' }, h.actorId);

    expect(h.invoicesRepository.updateStatus).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });
});
