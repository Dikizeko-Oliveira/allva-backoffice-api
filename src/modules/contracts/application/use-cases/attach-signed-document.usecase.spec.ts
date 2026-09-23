import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  EnterpriseContract,
  type CreateContractProps,
} from 'src/modules/contracts/domain/entities';
import {
  AttachSignedDocumentUseCase,
  MAX_SIGNED_DOCUMENT_BYTES,
  type SignedDocumentFile,
} from './attach-signed-document.usecase';

/**
 * O que a rota promete: só PDF de verdade entra, nada sobra no bucket quando
 * o contrato recusa, e a trilha registra sem expor a URL do documento.
 */

const NOVA = 'https://bucket/contracts/c-1/contrato-abc.pdf';
const ANTERIOR = 'https://bucket/contracts/c-1/contrato-errado.pdf';

function props(overrides: Partial<CreateContractProps> = {}) {
  return {
    contractNumber: 'ENT-2026-0012',
    salesLeadId: 'lead-1',
    planId: 'plan-enterprise',
    startsAt: new Date('2026-09-01T00:00:00Z'),
    endsAt: new Date('2027-09-01T00:00:00Z'),
    billingInterval: 'ANNUAL',
    billingAmount: 48000,
    setupFeeAmount: null,
    currency: 'BRL',
    paymentTerms: 'NET_30',
    paymentMethod: 'BOLETO',
    activateOnSignature: true,
    gracePeriodDays: 7,
    autoRenew: false,
    limits: {
      maxSeats: null,
      maxAdAccounts: null,
      maxMonitoredAds: null,
      maxOrganizations: null,
      llmDailyBudgetBase: null,
    },
    signedAt: new Date('2026-08-30T00:00:00Z'),
    signedDocumentUrl: null,
    ...overrides,
  } as CreateContractProps;
}

function pdf(overrides: Partial<SignedDocumentFile> = {}): SignedDocumentFile {
  const buffer = Buffer.from('%PDF-1.7\n...');
  return {
    buffer,
    originalname: 'contrato.pdf',
    mimetype: 'application/pdf',
    size: buffer.length,
    ...overrides,
  };
}

function build(contract: EnterpriseContract | null) {
  const contracts = {
    findById: jest.fn().mockResolvedValue(contract),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const platformRole = { assertPermission: jest.fn().mockResolvedValue(true) };
  const storage = {
    upload: jest.fn().mockResolvedValue({ url: NOVA, key: 'k' }),
    ownsUrl: jest.fn((url: string) => url.startsWith('https://bucket/')),
    deleteByUrl: jest.fn().mockResolvedValue(undefined),
  };
  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const useCase = new AttachSignedDocumentUseCase(
    contracts as never,
    platformRole as never,
    storage as never,
    auditLog as never,
  );

  return { useCase, contracts, platformRole, storage, auditLog };
}

describe('AttachSignedDocumentUseCase', () => {
  it('guarda o PDF na pasta do contrato e grava a URL', async () => {
    const contract = EnterpriseContract.create(props());
    const { useCase, storage, contracts, platformRole } = build(contract);

    const output = await useCase.execute(contract.id, pdf(), 'op-1');

    expect(platformRole.assertPermission).toHaveBeenCalledWith(
      'op-1',
      'billing:manage',
    );
    expect(storage.upload).toHaveBeenCalledWith(
      expect.any(Buffer),
      'contrato.pdf',
      'application/pdf',
      `contracts/${contract.id}`,
    );
    expect(contracts.update).toHaveBeenCalledWith(contract);
    expect(output.signedDocumentUrl).toBe(NOVA);
  });

  it('audita sem a URL do documento', async () => {
    const contract = EnterpriseContract.create(props());
    const { useCase, auditLog } = build(contract);

    await useCase.execute(contract.id, pdf(), 'op-1');

    const [entry] = auditLog.record.mock.calls[0];
    expect(entry).toMatchObject({
      event: 'contract.signed_document.attached',
      entityId: contract.id,
      actorId: 'op-1',
      metadata: { replaced: false, filename: 'contrato.pdf' },
    });
    expect(JSON.stringify(entry)).not.toContain('https://');
  });

  it('antes da ativação, trocar apaga o arquivo anterior do bucket', async () => {
    const contract = EnterpriseContract.create(
      props({ signedDocumentUrl: ANTERIOR }),
    );
    const { useCase, storage, auditLog } = build(contract);

    await useCase.execute(contract.id, pdf(), 'op-1');

    expect(storage.deleteByUrl).toHaveBeenCalledWith(ANTERIOR);
    expect(auditLog.record.mock.calls[0][0].metadata.replaced).toBe(true);
  });

  it('não tenta apagar um link externo colado à mão', async () => {
    const contract = EnterpriseContract.create(
      props({ signedDocumentUrl: 'https://drive.example.com/contrato' }),
    );
    const { useCase, storage } = build(contract);

    await useCase.execute(contract.id, pdf(), 'op-1');

    expect(storage.deleteByUrl).not.toHaveBeenCalled();
  });

  it('recusa com 409, e sem upload, trocar o documento de contrato ativado', async () => {
    const contract = EnterpriseContract.create(
      props({ signedDocumentUrl: ANTERIOR }),
    );
    contract.activate(new Date('2026-09-02T00:00:00Z'));
    const { useCase, storage, contracts } = build(contract);

    await expect(useCase.execute(contract.id, pdf(), 'op-1')).rejects.toThrow(
      ConflictException,
    );
    expect(storage.upload).not.toHaveBeenCalled();
    expect(contracts.update).not.toHaveBeenCalled();
  });

  it('apaga o arquivo recém-subido se a gravação falhar', async () => {
    const contract = EnterpriseContract.create(props());
    const { useCase, storage, contracts } = build(contract);
    contracts.update.mockRejectedValue(new Error('db down'));

    await expect(useCase.execute(contract.id, pdf(), 'op-1')).rejects.toThrow(
      'db down',
    );
    expect(storage.deleteByUrl).toHaveBeenCalledWith(NOVA);
  });

  it('recusa arquivo que diz ser PDF mas não é', async () => {
    const contract = EnterpriseContract.create(props());
    const { useCase, storage } = build(contract);

    await expect(
      useCase.execute(
        contract.id,
        pdf({ buffer: Buffer.from('MZ\x90\x00 executável') }),
        'op-1',
      ),
    ).rejects.toThrow(BadRequestException);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('recusa outro tipo de arquivo', async () => {
    const { useCase } = build(EnterpriseContract.create(props()));

    await expect(
      useCase.execute('c-1', pdf({ mimetype: 'image/png' }), 'op-1'),
    ).rejects.toThrow(BadRequestException);
  });

  it('recusa arquivo acima do teto', async () => {
    const { useCase } = build(EnterpriseContract.create(props()));

    await expect(
      useCase.execute(
        'c-1',
        pdf({ size: MAX_SIGNED_DOCUMENT_BYTES + 1 }),
        'op-1',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('recusa sem arquivo', async () => {
    const { useCase } = build(EnterpriseContract.create(props()));

    await expect(useCase.execute('c-1', undefined, 'op-1')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('404 para contrato inexistente', async () => {
    const { useCase } = build(null);

    await expect(useCase.execute('nope', pdf(), 'op-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});
