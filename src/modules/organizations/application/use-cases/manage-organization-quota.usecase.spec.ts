import { ManageOrganizationQuotaUseCase } from './manage-organization-quota.usecase';

const NONE = {
  adAccounts: null,
  monitoredAds: null,
  seats: null,
  organizations: null,
};

function build(options: { role?: string; organizationExists?: boolean } = {}) {
  // Financeiro: limite contratado é cláusula comercial (`orgs:quota_manage`).
  const { role = 'ALLVA_FINANCE', organizationExists = true } = options;

  const organizationsRepository = {
    findById: jest
      .fn()
      .mockResolvedValue(organizationExists ? { id: 'org-1' } : null),
  };

  const stored = { ...NONE };
  const quotas = {
    findOverrides: jest.fn().mockImplementation(() => ({ ...stored })),
    upsertOverrides: jest.fn().mockImplementation((_id, patch) => {
      Object.assign(stored, patch);
      return { ...stored };
    }),
  };

  /** O teto de gasto mora noutra tabela, e o dublê guarda estado como o real. */
  let budget: number | null = 50;
  const adsSettings = {
    findLlmDailyBudget: jest.fn().mockImplementation(() => budget),
    updateLlmDailyBudget: jest
      .fn()
      .mockImplementation((_id, value: number | null) => {
        budget = value;
        return budget;
      }),
  };

  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'actor-1', role }),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  return {
    service: new ManageOrganizationQuotaUseCase(
      organizationsRepository as never,
      quotas as never,
      adsSettings as never,
      accountsRepository as never,
      auditLog as never,
    ),
    quotas,
    adsSettings,
    auditLog,
  };
}

describe('quem pode mexer no teto negociado', () => {
  it('recusa quem não é operador da plataforma', async () => {
    // O dono da organização escolhendo o próprio teto é o oposto de negociá-lo.
    const h = build({ role: 'OWNER' });

    await expect(
      h.service.update('org-1', { maxAdAccounts: 500 }, 'actor-1'),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_AUTHORIZED' } });

    expect(h.quotas.upsertOverrides).not.toHaveBeenCalled();
  });

  /**
   * A mudança de comportamento de B13, fixada. Operações lê o teto (é
   * `orgs:read`) e não o altera: quem mexe em limite mexe no que foi vendido.
   * Com a guarda binária, qualquer operador fazia as duas coisas.
   */
  it('operações lê o teto, mas não o altera', async () => {
    const h = build({ role: 'ALLVA_OPERATOR' });

    await expect(h.service.read('org-1', 'actor-1')).resolves.toBeDefined();
    await expect(
      h.service.update('org-1', { maxAdAccounts: 500 }, 'actor-1'),
    ).rejects.toMatchObject({
      response: {
        code: 'ACCOUNT_NOT_AUTHORIZED',
        details: { permission: 'orgs:quota_manage' },
      },
    });

    expect(h.quotas.upsertOverrides).not.toHaveBeenCalled();
  });

  it('recusa organização inexistente antes de gravar', async () => {
    const h = build({ organizationExists: false });

    await expect(
      h.service.update('org-x', { maxSeats: 40 }, 'actor-1'),
    ).rejects.toMatchObject({ response: { code: 'ORGANIZATION_NOT_FOUND' } });

    expect(h.quotas.upsertOverrides).not.toHaveBeenCalled();
  });
});

describe('omitir e limpar são coisas diferentes', () => {
  it('campo omitido não mexe nos demais', async () => {
    const h = build();

    await h.service.update(
      'org-1',
      { maxAdAccounts: 120, maxSeats: 80 },
      'actor-1',
    );

    // O defeito que a distinção evita: corrigir só as contas apagaria os outros
    // tetos contratados, sem ninguém perceber até o cliente esbarrar num limite.
    const result = await h.service.update(
      'org-1',
      { maxAdAccounts: 200 },
      'actor-1',
    );

    expect(result.maxAdAccounts).toBe(200);
    expect(result.maxSeats).toBe(80);
  });

  it('`null` devolve a linha ao plano', async () => {
    const h = build();

    await h.service.update('org-1', { maxAdAccounts: 120 }, 'actor-1');
    const result = await h.service.update(
      'org-1',
      { maxAdAccounts: null },
      'actor-1',
    );

    expect(result.maxAdAccounts).toBeNull();
  });

  it('o patch enviado à porta carrega só o que veio', async () => {
    const h = build();

    await h.service.update('org-1', { maxOrganizations: 10 }, 'actor-1');

    expect(h.quotas.upsertOverrides).toHaveBeenCalledWith('org-1', {
      organizations: 10,
    });
  });
});

describe('a trilha de auditoria', () => {
  it('registra o par antes/depois — "o que mudou" é a pergunta', async () => {
    const h = build();

    await h.service.update('org-1', { maxAdAccounts: 120 }, 'actor-1');

    expect(h.auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'organization.quota.updated',
        actorId: 'actor-1',
        organizationId: 'org-1',
        metadata: {
          // O teto de gasto entra no par mesmo sem ter sido tocado: a pergunta
          // que se faz a uma trilha é "como estava a organização", e um retrato
          // que omite metade das alavancas não responde.
          before: { ...NONE, llmDailyBudgetBase: 50 },
          after: { ...NONE, adAccounts: 120, llmDailyBudgetBase: 50 },
        },
      }),
    );
  });
});

/**
 * O teto **diário de gasto com IA** — a única alavanca desta rota que mora em
 * `organization_ads_settings` e não em `organization_quotas`.
 *
 * Ela está aqui porque move dinheiro e contorna o plano, e não na rota de
 * configuração da organização, que é do cliente. Antes desta entrega a coluna
 * não tinha caminho de escrita nenhum: nascia nula, e nulo significa **sem
 * teto** para `evaluateBudget`.
 */
describe('o teto diário de gasto com IA', () => {
  it('é lido junto das cotas, na mesma resposta', async () => {
    const h = build();

    await expect(h.service.read('org-1', 'actor-1')).resolves.toMatchObject({
      llmDailyBudgetBase: 50,
    });
  });

  it('grava o número do contrato por cima do default', async () => {
    const h = build();

    const after = await h.service.update(
      'org-1',
      { llmDailyBudgetBase: 200 },
      'actor-1',
    );

    expect(after.llmDailyBudgetBase).toBe(200);
    expect(h.adsSettings.updateLlmDailyBudget).toHaveBeenCalledWith(
      'org-1',
      200,
    );
  });

  it('`null` remove o teto — contrato ainda não precificado', async () => {
    // A alternativa seria inventar um número no lugar do comercial, e um teto
    // inventado corta entrega contratada na primeira madrugada.
    const h = build();

    const after = await h.service.update(
      'org-1',
      { llmDailyBudgetBase: null },
      'actor-1',
    );

    expect(after.llmDailyBudgetBase).toBeNull();
  });

  it('campo omitido não apaga o teto', async () => {
    /**
     * A distinção de três estados vale ainda mais aqui que nas cotas: tratar
     * `undefined` como `null` apagaria a parede de gasto de uma organização em
     * toda requisição que corrigisse outro número — e ninguém notaria, porque o
     * efeito é o produto **não** cortar.
     */
    const h = build();

    const after = await h.service.update(
      'org-1',
      { maxAdAccounts: 120 },
      'actor-1',
    );

    expect(after.llmDailyBudgetBase).toBe(50);
    expect(h.adsSettings.updateLlmDailyBudget).not.toHaveBeenCalled();
  });
});
