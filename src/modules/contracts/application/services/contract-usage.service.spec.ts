import { ContractUsageService } from './contract-usage.service';

/**
 * O retrato que o operador vê antes de assinar um aditivo.
 *
 * Ele não impede nada — impedir bloquearia uma redução datada para janeiro,
 * assinada em setembro justamente porque o cliente vai encolher até lá. O que
 * ele evita é o operador descobrir depois, sobretudo em anúncios monitorados:
 * assentos e contas de anúncio são portões que recusam o próximo, mas o teto de
 * anúncios é lido por uma varredura noturna que tira a diferença da análise sem
 * ninguém clicar em nada.
 */

const SEM_MUDANCA = {
  billingAmount: null,
  maxSeats: null,
  maxAdAccounts: null,
  maxMonitoredAds: null,
  maxOrganizations: null,
  llmDailyBudgetBase: null,
};

function montar(uso: {
  seats?: number;
  adAccounts?: number;
  monitoredAds?: number;
  organizations?: number;
}) {
  const seats = {
    resolve: jest.fn().mockResolvedValue({ used: uso.seats ?? 0 }),
  };
  const adAccounts = {
    countActiveByOrganizationId: jest
      .fn()
      .mockResolvedValue(uso.adAccounts ?? 0),
  };
  const analysisScope = {
    countEligible: jest.fn().mockResolvedValue(uso.monitoredAds ?? 0),
  };
  const organizations = {
    findById: jest.fn().mockResolvedValue({ ownerId: 'dono-1' }),
    countByOwnerId: jest.fn().mockResolvedValue(uso.organizations ?? 0),
  };

  return {
    service: new ContractUsageService(
      seats as never,
      adAccounts as never,
      analysisScope as never,
      organizations as never,
    ),
    seats,
    adAccounts,
    analysisScope,
    organizations,
  };
}

describe('só as dimensões que o aditivo toca', () => {
  it('um aditivo de assentos não conta anúncio nenhum', async () => {
    const h = montar({ seats: 252 });

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxSeats: 150,
    });

    expect(Object.keys(usage)).toEqual(['seats']);
    // Contar o uso de um teto que ninguém renegociou encheria a resposta de
    // números que não pedem decisão nenhuma — e pagaria por consultas à toa.
    expect(h.analysisScope.countEligible).not.toHaveBeenCalled();
    expect(h.adAccounts.countActiveByOrganizationId).not.toHaveBeenCalled();
  });

  it('mudança só de valor não conta nada', async () => {
    const h = montar({});

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      billingAmount: 72000,
    });

    expect(usage).toEqual({});
    expect(h.seats.resolve).not.toHaveBeenCalled();
  });
});

describe('o que o retrato diz', () => {
  it('acusa quando o teto novo já nasce estourado', async () => {
    const h = montar({ seats: 252 });

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxSeats: 150,
    });

    expect(usage.seats).toEqual({ used: 252, ceiling: 150, exceeds: true });
  });

  it('uma expansão não acusa nada', async () => {
    const h = montar({ seats: 120 });

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxSeats: 250,
    });

    expect(usage.seats?.exceeds).toBe(false);
  });

  it('no limite exato não estoura', async () => {
    const h = montar({ seats: 150 });

    // 150 em uso com teto 150 é a organização cheia, não a organização acima.
    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxSeats: 150,
    });

    expect(usage.seats?.exceeds).toBe(false);
  });

  it('nomeia todas as dimensões estouradas', async () => {
    const h = montar({ seats: 252, monitoredAds: 480, adAccounts: 5 });

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxSeats: 150,
      maxMonitoredAds: 200,
      maxAdAccounts: 30,
    });

    // É o que vai para o `logger.warn` e para a trilha: quando alguém
    // perguntar por que sumiram anúncios, a causa está a uma consulta.
    expect(ContractUsageService.exceeded(usage).sort()).toEqual([
      'monitoredAds',
      'seats',
    ]);
  });
});

describe('o teto de organizações é do titular', () => {
  it('conta as organizações do dono, não a organização do contrato', async () => {
    const h = montar({ organizations: 4 });

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxOrganizations: 3,
      llmDailyBudgetBase: null,
    });

    /**
     * Uma holding negocia "até cinco organizações" e as distribui entre as
     * unidades. Contar as da organização em que o contrato está daria sempre
     * um, e o teto nunca pareceria estourado.
     */
    expect(h.organizations.countByOwnerId).toHaveBeenCalledWith('dono-1');
    expect(usage.organizations).toEqual({
      used: 4,
      ceiling: 3,
      exceeds: true,
    });
  });

  it('organização que sumiu não quebra o retrato', async () => {
    const h = montar({ organizations: 4 });
    h.organizations.findById.mockResolvedValue(null);

    const usage = await h.service.forChanges('org-1', {
      ...SEM_MUDANCA,
      maxOrganizations: 3,
      llmDailyBudgetBase: null,
    });

    expect(usage.organizations?.used).toBe(0);
  });
});
