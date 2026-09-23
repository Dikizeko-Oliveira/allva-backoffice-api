import { SupportTicket } from 'src/modules/support/domain/entities';
import {
  SupportTicketContext,
  SupportTicketNotifierService,
} from './support-ticket-notifier.service';

function buildTicket({
  priority = 'MEDIUM' as SupportTicket['priority'],
  withAttachment = false,
}: { priority?: SupportTicket['priority']; withAttachment?: boolean } = {}) {
  return SupportTicket.create({
    accountId: 'acc-1',
    organizationId: 'org-1',
    authorName: 'Ana',
    authorEmail: 'ana@empresa.com',
    subject: 'Não consigo conectar minha conta',
    message: 'O botão de conectar não responde.',
    priority,
    attachment: withAttachment
      ? {
          url: 'https://storage.googleapis.com/bucket/print.png',
          key: 'support-tickets/org-1/print-abc123.png',
          storageProvider: 'gcs',
          filename: 'print.png',
        }
      : null,
  });
}

function buildContext(
  overrides: Partial<SupportTicketContext> = {},
): SupportTicketContext {
  return {
    userName: 'Ana',
    userEmail: 'ana@empresa.com',
    organizationName: 'Empresa X',
    planLabel: 'Profissional',
    supportEmail: 'suporte@allva.com.br',
    dateLabel: '28 de agosto de 2026 às 14:32',
    ...overrides,
  };
}

function buildHarness({
  sendFails = false,
  getReadUrlFails = false,
}: { sendFails?: boolean; getReadUrlFails?: boolean } = {}) {
  const send = jest
    .fn()
    .mockImplementation(() =>
      sendFails ? Promise.reject(new Error('smtp down')) : Promise.resolve(),
    );
  const emailSender = { send } as never;

  const render = jest.fn().mockImplementation((templateName: string) =>
    Promise.resolve({
      subject: 'ignored',
      html: `<p>${templateName}</p>`,
      text: templateName,
    }),
  );
  const emailTemplates = { render } as never;

  const getReadUrl = jest
    .fn()
    .mockImplementation((url: string) =>
      getReadUrlFails
        ? Promise.reject(new Error('signing failed'))
        : Promise.resolve(`${url}?signed=1`),
    );
  const storage = { getReadUrl } as never;

  const service = new SupportTicketNotifierService(
    emailSender,
    emailTemplates,
    storage,
  );

  for (const level of ['log', 'error'] as const) {
    jest
      .spyOn((service as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return { service, send, render, getReadUrl };
}

describe('SupportTicketNotifierService', () => {
  describe('notifySupportTeam', () => {
    it('TO é sempre supportEmail, SUBJECT é o assunto do usuário, REPLY-TO é o usuário', async () => {
      const h = buildHarness();
      const ticket = buildTicket();

      await h.service.notifySupportTeam(ticket, buildContext());

      const call = h.send.mock.calls[0][0];
      expect(call.to).toBe('suporte@allva.com.br');
      expect(call.subject).toBe(`[Suporte Allva] ${ticket.subject}`);
      expect(call.replyTo).toBe('ana@empresa.com');
      // ALLVA_SUPPORT_EMAIL nunca é usado como remetente.
      expect(call.from).toBeUndefined();
    });

    it('renderiza support-request com código e rótulo de prioridade em português', async () => {
      const h = buildHarness();
      const ticket = buildTicket({ priority: 'HIGH' });

      await h.service.notifySupportTeam(ticket, buildContext());

      expect(h.render).toHaveBeenCalledWith(
        'support-request',
        expect.objectContaining({
          ticketCode: ticket.code,
          priorityLabel: 'Alta',
          subject: ticket.subject,
          message: ticket.message,
        }),
      );
    });

    it('sem anexo, o template recebe attachmentUrl indefinido e getReadUrl não é chamado', async () => {
      const h = buildHarness();

      await h.service.notifySupportTeam(buildTicket(), buildContext());

      expect(h.getReadUrl).not.toHaveBeenCalled();
      const [, props] = h.render.mock.calls[0];
      expect(props.attachmentUrl).toBeUndefined();
    });

    it('com anexo, assina a URL gravada e passa a versão assinada ao template', async () => {
      const h = buildHarness();
      const ticket = buildTicket({ withAttachment: true });

      await h.service.notifySupportTeam(ticket, buildContext());

      expect(h.getReadUrl).toHaveBeenCalledWith(
        ticket.attachmentUrl,
        expect.any(Number),
      );
      const [, props] = h.render.mock.calls[0];
      expect(props.attachmentUrl).toBe(`${ticket.attachmentUrl}?signed=1`);
    });

    it('se a assinatura do anexo falhar, o e-mail ainda sai, sem link', async () => {
      const h = buildHarness({ getReadUrlFails: true });
      const ticket = buildTicket({ withAttachment: true });

      await expect(
        h.service.notifySupportTeam(ticket, buildContext()),
      ).resolves.toBeUndefined();

      const [, props] = h.render.mock.calls[0];
      expect(props.attachmentUrl).toBeUndefined();
      expect(h.send).toHaveBeenCalledTimes(1);
    });

    it('propaga a falha de envio — é o único aviso em tempo real que o suporte tem hoje', async () => {
      const h = buildHarness({ sendFails: true });

      await expect(
        h.service.notifySupportTeam(buildTicket(), buildContext()),
      ).rejects.toThrow('smtp down');
    });
  });

  describe('notifyRequester', () => {
    it('TO é o usuário, SUBJECT cita o código do chamado, REPLY-TO é o suporte', async () => {
      const h = buildHarness();
      const ticket = buildTicket();

      await h.service.notifyRequester(ticket, buildContext());

      const call = h.send.mock.calls[0][0];
      expect(call.to).toBe('ana@empresa.com');
      expect(call.subject).toContain(ticket.code);
      expect(call.replyTo).toBe('suporte@allva.com.br');
      expect(call.from).toBeUndefined();
    });

    it('nunca lança — é um recibo, não pode derrubar um chamado já salvo', async () => {
      const h = buildHarness({ sendFails: true });

      await expect(
        h.service.notifyRequester(buildTicket(), buildContext()),
      ).resolves.toBeUndefined();
    });
  });
});
