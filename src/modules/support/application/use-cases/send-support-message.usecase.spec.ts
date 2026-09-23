import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { SendSupportMessageUseCase } from './send-support-message.usecase';

const DTO = {
  subject: 'Não consigo conectar minha conta do Meta',
  message: 'O botão de conectar não responde depois do login.',
};

const FILE = {
  buffer: Buffer.from('fake-png-bytes'),
  originalname: 'print.png',
  mimetype: 'image/png',
  size: 1024,
} as Express.Multer.File;

const UPLOADED_ATTACHMENT = {
  url: 'https://storage.googleapis.com/bucket/print.png',
  key: 'support-tickets/org-1/print-abc123.png',
  storageProvider: 'gcs',
  filename: 'print.png',
};

function buildHarness({
  allowed = true,
  hasPriority = false,
  supportEmail = 'suporte@allva.com.br',
  account = { id: 'acc-1', name: 'Ana', email: 'ana@empresa.com' } as {
    id: string;
    name: string;
    email: string;
  } | null,
  organization = { id: 'org-1', name: 'Empresa X' } as {
    id: string;
    name: string;
  } | null,
  planType = 'PRO' as string | null,
  validateThrows = false,
}: {
  allowed?: boolean;
  hasPriority?: boolean;
  supportEmail?: string | undefined;
  account?: { id: string; name: string; email: string } | null;
  organization?: { id: string; name: string } | null;
  planType?: string | null;
  validateThrows?: boolean;
} = {}) {
  const findAccountById = jest.fn().mockResolvedValue(account);
  const accountsRepository = { findById: findAccountById } as never;

  const findOrgById = jest.fn().mockResolvedValue(organization);
  const organizationsRepository = { findById: findOrgById } as never;

  const findPlanTypeByOrganizationId = jest.fn().mockResolvedValue(planType);
  const organizationPlan = { findPlanTypeByOrganizationId } as never;

  const stateFor = jest.fn().mockResolvedValue(
    allowed
      ? { allowed: true }
      : {
          allowed: false,
          planLabel: 'Individual',
          featureLabel: 'Suporte por e-mail',
          upgradeTo: 'Profissional',
        },
  );
  const allows = jest.fn().mockResolvedValue(hasPriority);
  const planEntitlement = { stateFor, allows } as never;

  const saveTicket = jest.fn().mockResolvedValue(undefined);
  const ticketsRepository = { save: saveTicket } as never;

  const appendMessage = jest.fn().mockResolvedValue(undefined);
  const messagesRepository = { append: appendMessage } as never;

  const validate = jest.fn().mockImplementation(() => {
    if (validateThrows) {
      throw new BadRequestException({ code: 'INVALID_ATTACHMENT_TYPE' });
    }
  });
  const upload = jest.fn().mockResolvedValue(UPLOADED_ATTACHMENT);
  const attachments = { validate, upload } as never;

  const notifySupportTeam = jest.fn().mockResolvedValue(undefined);
  const notifyRequester = jest.fn().mockResolvedValue(undefined);
  /**
   * `notifyBoth` é o método real reimplementado no dublê — e não mais um
   * `jest.fn()`.
   *
   * O use case deixou de montar `dateLabel` e de escolher a ordem dos dois
   * envios; quem faz isso agora é o serviço. Um dublê que só registrasse a
   * chamada apagaria as duas garantias que estes testes cobram: que a equipe
   * é avisada **antes** do solicitante, e que os dois recebem exatamente o
   * mesmo contexto.
   */
  const notifier = {
    notifySupportTeam,
    notifyRequester,
    notifyBoth: async (
      ticket: { createdAt: Date },
      input: Record<string, unknown>,
    ) => {
      const context = {
        ...input,
        dateLabel: ticket.createdAt.toLocaleString('pt-BR', {
          dateStyle: 'long',
          timeStyle: 'short',
        }),
      };

      await notifySupportTeam(ticket, context);
      await notifyRequester(ticket, context);
    },
  } as never;

  const envValues: Record<string, string | undefined> = {
    ALLVA_SUPPORT_EMAIL: supportEmail,
  };
  const env = { get: jest.fn((key: string) => envValues[key]) } as never;

  const useCase = new SendSupportMessageUseCase(
    accountsRepository,
    organizationsRepository,
    organizationPlan,
    planEntitlement,
    ticketsRepository,
    messagesRepository,
    attachments,
    notifier,
    env,
  );

  for (const level of ['log', 'error'] as const) {
    jest
      .spyOn((useCase as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return {
    useCase,
    saveTicket,
    appendMessage,
    notifySupportTeam,
    notifyRequester,
    validate,
    upload,
    stateFor,
    allows,
    findAccountById,
  };
}

describe('SendSupportMessageUseCase', () => {
  it('grava o chamado e notifica o suporte e o requerente, nessa ordem', async () => {
    const h = buildHarness();

    const result = await h.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(result.sent).toBe(true);
    expect(result.ticketCode).toMatch(/^SUP-\d{8}-[A-Z0-9]{4}$/);
    expect(result.attachmentUploaded).toBe(false);
    expect(h.saveTicket).toHaveBeenCalledTimes(1);
    expect(h.notifySupportTeam).toHaveBeenCalledTimes(1);
    expect(h.notifyRequester).toHaveBeenCalledTimes(1);

    const saveOrder = h.saveTicket.mock.invocationCallOrder[0];
    const supportOrder = h.notifySupportTeam.mock.invocationCallOrder[0];
    const requesterOrder = h.notifyRequester.mock.invocationCallOrder[0];

    // Salvar primeiro: é o registro durável que sobrevive a um provedor de
    // e-mail fora do ar. Suporte antes do requerente: se algo falhar no meio,
    // é melhor a equipe já ter sido avisada do que o contrário.
    expect(saveOrder).toBeLessThan(supportOrder);
    expect(supportOrder).toBeLessThan(requesterOrder);
  });

  it('grava o chamado com os campos esperados, sem operador atribuído', async () => {
    const h = buildHarness();

    const result = await h.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    const ticket = h.saveTicket.mock.calls[0][0];
    expect(ticket.code).toBe(result.ticketCode);
    expect(ticket.accountId).toBe('acc-1');
    expect(ticket.organizationId).toBe('org-1');
    expect(ticket.authorName).toBe('Ana');
    expect(ticket.authorEmail).toBe('ana@empresa.com');
    expect(ticket.operatorId).toBeNull();
    expect(ticket.subject).toBe(DTO.subject);
    expect(ticket.message).toBe(DTO.message);
    expect(ticket.category).toBe('GENERAL');
    expect(ticket.status).toBe('OPEN');
    expect(ticket.hasAttachment).toBe(false);
  });

  it('a categoria informada no DTO é gravada no chamado', async () => {
    const h = buildHarness();

    await h.useCase.execute({
      dto: { ...DTO, category: 'BILLING' },
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(h.saveTicket.mock.calls[0][0].category).toBe('BILLING');
  });

  it('prioridade HIGH quando o plano inclui support-priority, MEDIUM quando não', async () => {
    const withPriority = buildHarness({ hasPriority: true });
    await withPriority.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });
    expect(withPriority.saveTicket.mock.calls[0][0].priority).toBe('HIGH');

    const withoutPriority = buildHarness({ hasPriority: false });
    await withoutPriority.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });
    expect(withoutPriority.saveTicket.mock.calls[0][0].priority).toBe('MEDIUM');
  });

  it('a prioridade declarada pelo solicitante vale, dentro do teto do plano', async () => {
    const h = buildHarness({ hasPriority: true });

    const result = await h.useCase.execute({
      dto: { ...DTO, priority: 'CRITICAL' as const },
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(h.saveTicket.mock.calls[0][0].priority).toBe('CRITICAL');
    // A resposta publica a prioridade **efetiva**, não a pedida: é o único
    // jeito de a tela confirmar o que foi gravado sem reler o chamado.
    expect(result.priority).toBe('CRITICAL');
  });

  it('sem support-priority, a declaração é limitada a MEDIUM — declarar não fura fila', async () => {
    const h = buildHarness({ hasPriority: false });

    const result = await h.useCase.execute({
      dto: { ...DTO, priority: 'CRITICAL' as const },
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(h.saveTicket.mock.calls[0][0].priority).toBe('MEDIUM');
    expect(result.priority).toBe('MEDIUM');
  });

  it('LOW declarado continua LOW mesmo sem support-priority', async () => {
    const h = buildHarness({ hasPriority: false });

    await h.useCase.execute({
      dto: { ...DTO, priority: 'LOW' as const },
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(h.saveTicket.mock.calls[0][0].priority).toBe('LOW');
  });

  it('com anexo, valida antes de fazer qualquer trabalho e sobe o arquivo para a pasta da organização', async () => {
    const h = buildHarness();

    const result = await h.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
      attachment: FILE,
    });

    expect(h.validate).toHaveBeenCalledWith(FILE);
    // Validado antes do resto — não vale gastar uma consulta de entitlement
    // com um arquivo que vai ser recusado.
    expect(h.validate.mock.invocationCallOrder[0]).toBeLessThan(
      h.stateFor.mock.invocationCallOrder[0],
    );

    expect(h.upload).toHaveBeenCalledWith(FILE, 'org-1');
    expect(result.attachmentUploaded).toBe(true);

    const ticket = h.saveTicket.mock.calls[0][0];
    expect(ticket.attachmentUrl).toBe(UPLOADED_ATTACHMENT.url);
    expect(ticket.attachmentFilename).toBe(UPLOADED_ATTACHMENT.filename);
  });

  it('sem anexo, o upload nunca é chamado', async () => {
    const h = buildHarness();

    await h.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    expect(h.validate).toHaveBeenCalledWith(undefined);
    expect(h.upload).not.toHaveBeenCalled();
  });

  it('anexo inválido recusa antes de tocar em entitlement, conta ou banco', async () => {
    const h = buildHarness({ validateThrows: true });

    await expect(
      h.useCase.execute({
        dto: DTO,
        accountId: 'acc-1',
        organizationId: 'org-1',
        attachment: FILE,
      }),
    ).rejects.toMatchObject({
      response: { code: 'INVALID_ATTACHMENT_TYPE' },
    });

    expect(h.stateFor).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.saveTicket).not.toHaveBeenCalled();
  });

  it('o contexto passado ao notificador traz plano e organização resolvidos no servidor', async () => {
    const h = buildHarness({
      account: { id: 'acc-1', name: 'Ana', email: 'ana@empresa.com' },
      organization: { id: 'org-1', name: 'Empresa X' },
      planType: 'PRO',
    });

    await h.useCase.execute({
      dto: DTO,
      accountId: 'acc-1',
      organizationId: 'org-1',
    });

    const [, context] = h.notifySupportTeam.mock.calls[0];
    expect(context).toMatchObject({
      userName: 'Ana',
      userEmail: 'ana@empresa.com',
      organizationName: 'Empresa X',
      planLabel: 'Profissional',
      supportEmail: 'suporte@allva.com.br',
    });

    // O mesmo contexto vai para o requerente — um só lugar decide plano e
    // organização, não dois.
    expect(h.notifyRequester.mock.calls[0][1]).toEqual(context);
  });

  it('recusa sem X-Organization-Id — identidade vem do contexto, não do corpo', async () => {
    const h = buildHarness();

    await expect(
      h.useCase.execute({ dto: DTO, accountId: 'acc-1', organizationId: null }),
    ).rejects.toThrow(ForbiddenException);

    expect(h.saveTicket).not.toHaveBeenCalled();
    expect(h.notifySupportTeam).not.toHaveBeenCalled();
  });

  it('recusa quando o plano não inclui support-email — o backend é a autoridade, não o Drawer', async () => {
    const h = buildHarness({ allowed: false });

    await expect(
      h.useCase.execute({
        dto: DTO,
        accountId: 'acc-1',
        organizationId: 'org-1',
      }),
    ).rejects.toMatchObject({
      code: 'PLAN_FEATURE_NOT_INCLUDED',
    });

    expect(h.saveTicket).not.toHaveBeenCalled();
    expect(h.notifySupportTeam).not.toHaveBeenCalled();
  });

  it('a recusa por plano é um DomainError PLAN_LIMITED — o mesmo caminho do resto do produto', async () => {
    const h = buildHarness({ allowed: false });

    await expect(
      h.useCase.execute({
        dto: DTO,
        accountId: 'acc-1',
        organizationId: 'org-1',
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it('recusa quando ALLVA_SUPPORT_EMAIL não está configurado', async () => {
    // '' e não undefined: um default de parâmetro dispara em `undefined`
    // explícito também, o que mascararia o teste sem exercitar o caminho real.
    const h = buildHarness({ supportEmail: '' });

    await expect(
      h.useCase.execute({
        dto: DTO,
        accountId: 'acc-1',
        organizationId: 'org-1',
      }),
    ).rejects.toMatchObject({
      response: { code: 'SUPPORT_EMAIL_NOT_CONFIGURED' },
    });

    expect(h.saveTicket).not.toHaveBeenCalled();
    expect(h.notifySupportTeam).not.toHaveBeenCalled();
  });

  it('recusa quando a conta autenticada não é encontrada', async () => {
    const h = buildHarness({ account: null });

    await expect(
      h.useCase.execute({
        dto: DTO,
        accountId: 'acc-1',
        organizationId: 'org-1',
      }),
    ).rejects.toThrow(NotFoundException);

    expect(h.saveTicket).not.toHaveBeenCalled();
    expect(h.notifySupportTeam).not.toHaveBeenCalled();
  });
});
