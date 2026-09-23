import { EnterpriseProvisioningService } from './enterprise-provisioning.service';

/**
 * O provisionamento cria a **configuração de ads** da organização (D16/A10).
 *
 * A tabela `organization_ads_settings` nasceu em A2-S1 e ninguém a criava: só o
 * seed de desenvolvimento produzia a linha, e toda organização provisionada por
 * lead `CLOSED_WON` nascia sem configuração. D16 existe para que "versão ativa"
 * não seja constante de código — sem a linha, A2-S4 teria de inventar um default
 * ou pular a organização em silêncio.
 *
 * O teste é sobre a transação, não sobre o Prisma: o que precisa ser verdade é
 * que a linha nasce **junto** com a organização e a assinatura, e que provisionar
 * duas vezes não tenta criá-la de novo.
 */

type Recorder = { table: string; op: string; data?: Record<string, unknown> };

function buildService(
  options: {
    adsSettingsExists?: boolean;
    /** O contrato que chega já ativado — o atalho de idempotência. */
    contractActivated?: boolean;
    existingSubscription?: {
      id: string;
      status: string;
      planId: string;
    } | null;
  } = {},
) {
  const calls: Recorder[] = [];

  const model = (table: string, existing: unknown = null) => ({
    findUnique: jest.fn().mockResolvedValue(existing),
    // `organizations.owner_id` deixou de ser único no multi-organização, então
    // o reuso passou a ser `findFirst` ordenado. O mock atende as duas para o
    // harness continuar servindo todas as tabelas com a mesma fábrica.
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn((args: { data: Record<string, unknown> }) => {
      calls.push({ table, op: 'create', data: args.data });
      return Promise.resolve(args.data);
    }),
    update: jest.fn(() => Promise.resolve({})),
  });

  const tx = {
    account: model('account'),
    preference: {
      ...model('preference'),
      upsert: jest.fn(() => Promise.resolve({})),
    },
    organization: model('organization'),
    organizationUser: model('organization_user'),
    organizationAdsSettings: model(
      'organization_ads_settings',
      options.adsSettingsExists ? { organizationId: 'org-existente' } : null,
    ),
    organizationSubscription: {
      ...model(
        'organization_subscription',
        options.existingSubscription ?? null,
      ),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push({
          table: 'organization_subscription',
          op: 'update',
          data: args.data,
        });
        return Promise.resolve(args.data);
      }),
    },
    organizationQuota: {
      ...model('organization_quota'),
      upsert: jest.fn((args: { create: Record<string, unknown> }) => {
        calls.push({
          table: 'organization_quota',
          op: 'upsert',
          data: args.create,
        });
        return Promise.resolve(args.create);
      }),
    },
    enterpriseContract: {
      ...model('enterprise_contract'),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        calls.push({
          table: 'enterprise_contract',
          op: 'update',
          data: args.data,
        });
        return Promise.resolve(args.data);
      }),
    },
    auditLog: model('audit_log'),
    salesLead: model('sales_lead'),
  };

  const prisma = {
    organizationSubscription: { findUnique: jest.fn() },
    enterpriseContract: {
      findUnique: jest.fn().mockResolvedValue(
        options.contractActivated
          ? {
              activatedAt: new Date('2026-01-01T00:00:00Z'),
              organizationId: 'org-existente',
            }
          : { activatedAt: null, organizationId: null },
      ),
    },
    $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };

  const service = new EnterpriseProvisioningService(
    prisma as never,
    {
      findByEmail: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockResolvedValue(null),
    } as never,
    { hash: jest.fn().mockResolvedValue('hash') } as never,
  );

  jest
    .spyOn((service as never as { logger: { log: jest.Mock } }).logger, 'log')
    .mockImplementation(() => undefined);

  return { service, calls, tx };
}

/** O que a ativação de um contrato manda provisionar. */
const CONTRATO = {
  lead: null as never,
  planId: 'plan-enterprise',
  limits: {
    maxSeats: 150,
    maxAdAccounts: 30,
    maxMonitoredAds: null,
    maxOrganizations: null,
    llmDailyBudgetBase: null,
  },
  contract: {
    id: 'contrato-1',
    status: 'ACTIVE',
    activatedAt: new Date('2026-09-03T12:00:00Z'),
  },
};

const LEAD = {
  id: 'lead-1',
  fullName: 'Fulana de Tal',
  workEmail: 'fulana@empresa.com.br',
  companyName: 'Empresa S.A.',
  desiredPlan: 'ENTERPRISE',
  status: 'CLOSED_WON',
  closedWonAt: new Date('2026-08-01T12:00:00Z'),
  assignedTo: 'vendedor-1',
  accountId: null,
  provisionedOrganizationId: null,
} as never;

describe('provisionamento cria a configuração de ads da organização (D16)', () => {
  it('cria `organization_ads_settings` na mesma transação da organização', async () => {
    const h = buildService();

    await h.service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const created = h.calls.filter((call) => call.op === 'create');
    expect(created.map((call) => call.table)).toContain(
      'organization_ads_settings',
    );

    // Junto, e não depois: a organização não pode existir sem a régua com que
    // sua mídia será medida.
    const organizationAt = created.findIndex(
      (call) => call.table === 'organization',
    );
    const settingsAt = created.findIndex(
      (call) => call.table === 'organization_ads_settings',
    );
    expect(settingsAt).toBeGreaterThan(organizationAt);
  });

  /**
   * A regra de D16 continua valendo, com **uma** exceção nomeada.
   *
   * Escrever `activeAlgoVersion` aqui seria reintroduzir a constante de código
   * que a decisão recusou, só que num lugar mais difícil de encontrar. O teto de
   * IA é diferente: o default do schema (R$ 50/dia) foi calibrado para o maior
   * plano de autoatendimento, e a narrativa noturna sai para todo score novo —
   * um contrato de 40.000 anúncios custa R$ 64/noite e seria cortado em ~31 mil
   * narrativas na primeira madrugada.
   */
  it('só decide o teto de IA — o resto continua vindo do schema (D16)', async () => {
    const h = buildService();

    await h.service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const settings = h.calls.find(
      (call) => call.table === 'organization_ads_settings',
    );

    expect(Object.keys(settings?.data ?? {}).sort()).toEqual([
      'llmDailyBudgetBase',
      'organizationId',
    ]);
  });

  it('grava o teto de IA que o contrato negociou', async () => {
    const h = buildService();

    await h.service.provisionForContract({
      ...CONTRATO,
      lead: LEAD,
      limits: { ...CONTRATO.limits, llmDailyBudgetBase: 400 },
    });

    const settings = h.calls.find(
      (call) => call.table === 'organization_ads_settings',
    );

    expect(settings?.data).toMatchObject({ llmDailyBudgetBase: 400 });
  });

  /**
   * **Contrato sem teto nasce sem teto**, e não com o default de
   * autoatendimento. É o defeito que esta correção fecha: o número de R$ 50 não
   * é do contrato, e aplicá-lo cortaria entrega contratada em silêncio.
   */
  it('contrato sem teto de IA não herda o default de autoatendimento', async () => {
    const h = buildService();

    await h.service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const settings = h.calls.find(
      (call) => call.table === 'organization_ads_settings',
    );

    expect(settings?.data).toMatchObject({ llmDailyBudgetBase: null });
  });

  it('é idempotente: organização já configurada não recria a linha', async () => {
    const h = buildService({ adsSettingsExists: true });

    await h.service.provisionForContract({ ...CONTRATO, lead: LEAD });

    expect(h.tx.organizationAdsSettings.create).not.toHaveBeenCalled();
  });
});

/**
 * O que o provisionamento passou a gravar quando virou dirigido pelo contrato.
 *
 * Antes ele criava organização, titular e assinatura — e parava aí. O acordo
 * comercial ficava fora: os 150 assentos negociados nasciam com o piso do
 * catálogo, e alguém tinha de lembrar de ajustar à mão. Um contrato que o
 * produto não lê é um documento.
 */
describe('a ativação grava o que foi negociado', () => {
  function gravado(calls: Recorder[], table: string) {
    return calls.find((call) => call.table === table)?.data;
  }

  it('a assinatura nasce ACTIVE e no plano do contrato', async () => {
    const { service, calls } = buildService();

    await service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const subscription = gravado(calls, 'organization_subscription');
    expect(subscription?.status).toBe('ACTIVE');
    expect(subscription?.planId).toBe('plan-enterprise');
    // Sem data de fim: quem responde "até quando" é a vigência do contrato.
    expect(subscription?.trialEndsAt).toBeNull();
  });

  it('os tetos negociados descem para a cota da organização', async () => {
    const { service, calls } = buildService();

    await service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const quota = gravado(calls, 'organization_quota');
    expect(quota?.maxSeats).toBe(150);
    expect(quota?.maxAdAccounts).toBe(30);
  });

  it('teto não negociado fica nulo — herda o plano, e não vira ilimitado', async () => {
    const { service, calls } = buildService();

    await service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const quota = gravado(calls, 'organization_quota');
    expect(quota?.maxMonitoredAds).toBeNull();
    expect(quota?.maxOrganizations).toBeNull();
  });

  it('o contrato aponta para a organização, na mesma transação', async () => {
    const { service, calls } = buildService();

    await service.provisionForContract({ ...CONTRATO, lead: LEAD });

    const contrato = gravado(calls, 'enterprise_contract');
    expect(contrato?.organizationId).toBeDefined();
    expect(contrato?.status).toBe('ACTIVE');
    /**
     * Dentro da transação de propósito: fora dela existiria uma janela em que a
     * organização tem assinatura ativa e o contrato ainda diz `SIGNED` — e o
     * resolver leria acesso concedido sem contrato que o justifique.
     */
    expect(contrato?.activatedAt).toEqual(CONTRATO.contract.activatedAt);
  });

  it('grava o estado que o agregado decidiu, e não um seu', async () => {
    const { service, calls } = buildService();

    // `activateOnSignature: false` produz PENDING_ACTIVATION no agregado; aqui
    // só se persiste o que chegou decidido.
    await service.provisionForContract({
      ...CONTRATO,
      lead: LEAD,
      contract: { ...CONTRATO.contract, status: 'PENDING_ACTIVATION' },
    });

    expect(gravado(calls, 'enterprise_contract')?.status).toBe(
      'PENDING_ACTIVATION',
    );
  });
});

/**
 * A renovação atravessava o atalho de idempotência.
 *
 * A condição era "este lead já foi provisionado", e a renovação é um contrato
 * **novo no mesmo lead**: o atalho disparava, o sucessor ficava em `SIGNED`
 * para sempre, e o cliente perdia o acesso na virada — exatamente o dia em que
 * renovar deveria protegê-lo. Os tetos renegociados também nunca desciam para
 * a cota.
 */
describe('o atalho de idempotência olha o contrato, não o lead', () => {
  const LEAD_JA_PROVISIONADO = {
    ...(LEAD as unknown as Record<string, unknown>),
    provisionedOrganizationId: 'org-existente',
    accountId: 'conta-1',
  } as never;

  it('renovação no mesmo lead provisiona de novo', async () => {
    const h = buildService();

    const resultado = await h.service.provisionForContract({
      ...CONTRATO,
      lead: LEAD_JA_PROVISIONADO,
    });

    expect(resultado.alreadyProvisioned).toBe(false);
    // O carimbo que faltava: sem ele o sucessor nunca sai de `SIGNED`.
    expect(
      h.calls.some(
        (call) => call.table === 'enterprise_contract' && call.op === 'update',
      ),
    ).toBe(true);
  });

  it('e os tetos renegociados descem para a cota', async () => {
    const h = buildService();

    await h.service.provisionForContract({
      ...CONTRATO,
      lead: LEAD_JA_PROVISIONADO,
      limits: { ...CONTRATO.limits, maxSeats: 300 },
    });

    const cota = h.calls.find((call) => call.table === 'organization_quota');
    expect(cota?.data?.maxSeats).toBe(300);
  });

  it('o mesmo contrato ativado duas vezes ainda é atalho', async () => {
    const h = buildService({ contractActivated: true });

    const resultado = await h.service.provisionForContract({
      ...CONTRATO,
      lead: LEAD_JA_PROVISIONADO,
    });

    // O propósito original do atalho, preservado: a rede caiu entre a resposta
    // e quem esperava por ela, e a segunda chamada não pode duplicar nada.
    expect(resultado.alreadyProvisioned).toBe(true);
    expect(h.calls).toHaveLength(0);
  });

  it('renovação atrasada reabre a assinatura que o job havia fechado', async () => {
    const h = buildService({
      existingSubscription: {
        id: 'sub-1',
        status: 'EXPIRED',
        planId: 'plan-enterprise',
      },
    });

    await h.service.provisionForContract({
      ...CONTRATO,
      lead: LEAD_JA_PROVISIONADO,
    });

    /**
     * O contrato anterior venceu, o job revogou a assinatura, e o comercial
     * fechou o novo alguns dias depois. Reusar a linha como estava deixaria o
     * cliente com contrato ativo e acesso fechado.
     */
    const atualizada = h.calls.find(
      (call) =>
        call.table === 'organization_subscription' && call.op === 'update',
    );
    expect(atualizada?.data?.status).toBe('ACTIVE');
    expect(atualizada?.data?.trialEndsAt).toBeNull();
  });
});
