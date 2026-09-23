import type { SweepMode } from 'src/modules/subscriptions/access/domain/sweep-mode';
import { DailySummaryService } from './daily-summary.service';

type WasteRow = {
  priority: string;
  incurredAmountBase: number;
  baseCurrency: string;
  type: string;
  diagnosis: string;
};

const CRITICO: WasteRow = {
  priority: 'CRITICAL',
  incurredAmountBase: 100,
  baseCurrency: 'BRL',
  type: 'BUDGET_CAPPED',
  diagnosis: 'Orçamento esgotado.',
};

function buildHarness(
  wasteItems: WasteRow[],
  options: {
    /** Organização resolvida para a conta. Ausente = o escopo falha. */
    organizationId?: string;
    mode?: SweepMode;
    accessFails?: boolean;
  } = {},
) {
  const account = { id: 'acc-1', name: 'Ana', email: 'ana@empresa.com' };

  const prisma = {
    preference: {
      findMany: jest.fn().mockResolvedValue([
        {
          notificationByEmail: true,
          dailyResume: true,
          alertNotifications: true,
          promotionNotifications: true,
          productNewsNotification: true,
          account,
        },
      ]),
    },
    wasteItem: { findMany: jest.fn().mockResolvedValue(wasteItems) },
    recommendation: { count: jest.fn().mockResolvedValue(0) },
  };

  const emailSender = { send: jest.fn().mockResolvedValue(undefined) };
  const appUrl = { baseUrl: 'https://app.test' };
  // Sem organização declarada, o escopo falha de propósito: `dueToday` trata
  // isso como "sempre devido" (nunca bloqueia o resumo por um scope que não
  // resolveu), e a conta não passa pela pergunta de acesso.
  const scope = {
    resolveForAccount: options.organizationId
      ? jest.fn().mockResolvedValue({
          accountId: account.id,
          organizationId: options.organizationId,
        })
      : jest.fn().mockRejectedValue(new Error('no scope')),
  };
  const plans = { summaryCadenceFor: jest.fn().mockResolvedValue('DAILY') };
  const sweep = {
    modesFor: options.accessFails
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest.fn(async (ids: string[]) => {
          return new Map(ids.map((id) => [id, options.mode ?? 'FULL']));
        }),
  };

  const service = new DailySummaryService(
    prisma as any,
    emailSender as any,
    appUrl as any,
    scope as any,
    plans as any,
    sweep as any,
  );

  for (const level of ['log', 'warn', 'error'] as const) {
    jest
      .spyOn((service as any).logger, level)
      .mockImplementation(() => undefined);
  }

  return { service, emailSender, sweep };
}

describe('DailySummaryService — moeda-base, não BRL fixo', () => {
  /**
   * `formatCurrency` local ao serviço formatava tudo como `style: 'currency',
   * currency: 'BRL'` — uma organização com moeda-base USD ou EUR via "R$" no
   * resumo diário para um valor que nunca foi reais. O reader do e-mail é
   * `WasteItem.baseCurrency`, não um formatador cego à moeda real do dado.
   */
  it('formata o desperdício na moeda-base real da organização (USD), não em BRL', async () => {
    const h = buildHarness([
      {
        priority: 'CRITICAL',
        incurredAmountBase: 1234.5,
        baseCurrency: 'USD',
        type: 'BUDGET_CAPPED',
        diagnosis: 'Orçamento esgotado.',
      },
    ]);

    await h.service.sendForAll();

    expect(h.emailSender.send).toHaveBeenCalledTimes(1);
    const [message] = h.emailSender.send.mock.calls[0];
    expect(message.html).toContain('US$');
    expect(message.html).not.toContain('R$');
    expect(message.text).toContain('US$');
  });

  it('nunca deixa NaN/undefined/null vazar quando o valor incorrido é zero', async () => {
    const h = buildHarness([
      {
        priority: 'MEDIUM',
        incurredAmountBase: 0,
        baseCurrency: 'BRL',
        type: 'LOW_CTR',
        diagnosis: 'CTR abaixo do esperado.',
      },
    ]);

    await h.service.sendForAll();

    const [message] = h.emailSender.send.mock.calls[0];
    expect(message.html).not.toMatch(/\b(NaN|undefined|null)\b/);
    expect(message.text).not.toMatch(/\b(NaN|undefined|null)\b/);
  });

  it('envia tanto html quanto a versão em texto plano', async () => {
    const h = buildHarness([CRITICO]);

    await h.service.sendForAll();

    const [message] = h.emailSender.send.mock.calls[0];
    expect(message.html.length).toBeGreaterThan(0);
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toContain('<');
  });
});

/**
 * O resumo segue a mesma regra de acesso dos jobs.
 *
 * Ele descreve análise, e a análise já não roda para organização sem acesso —
 * mandá-lo seria apontar para uma tela fechada com números parados.
 */
describe('DailySummaryService — acesso da organização', () => {
  it('envia para organização com acesso aberto', async () => {
    const h = buildHarness([CRITICO], {
      organizationId: 'org-1',
      mode: 'FULL',
    });

    await h.service.sendForAll();

    expect(h.sweep.modesFor).toHaveBeenCalledWith(['org-1'], expect.any(Date));
    expect(h.emailSender.send).toHaveBeenCalledTimes(1);
  });

  it.each(['DAILY_SYNC_ONLY', 'NONE'] as const)(
    'não envia para organização sem acesso aberto (%s)',
    async (mode) => {
      const h = buildHarness([CRITICO], { organizationId: 'org-1', mode });

      const result = await h.service.sendForAll();

      expect(h.emailSender.send).not.toHaveBeenCalled();
      expect(result).toEqual({ sent: 0, skipped: 1, errors: 0 });
    },
  );

  it('falha ao consultar o acesso não silencia o resumo', async () => {
    const h = buildHarness([CRITICO], {
      organizationId: 'org-1',
      accessFails: true,
    });

    await h.service.sendForAll();

    expect(h.emailSender.send).toHaveBeenCalledTimes(1);
  });

  it('conta sem organização resolvível não passa pela pergunta de acesso', async () => {
    const h = buildHarness([CRITICO]);

    await h.service.sendForAll();

    expect(h.sweep.modesFor).toHaveBeenCalledWith([], expect.any(Date));
    expect(h.emailSender.send).toHaveBeenCalledTimes(1);
  });
});
