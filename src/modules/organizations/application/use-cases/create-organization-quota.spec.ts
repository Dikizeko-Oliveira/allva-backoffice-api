import { OrganizationLimitService } from '../services/organization-limit.service';
import { CreateOrganizationUseCase } from './create-organization.usecase';
import { GetOrganizationCreationAllowanceUseCase } from './get-organization-creation-allowance.usecase';

/**
 * Quantas organizações uma conta pode possuir passou a ser decisão de plano.
 *
 * Antes era decisão de schema: `owner_id` era `@unique` e a segunda era recusada
 * com `ORGANIZATION_ALREADY_EXISTS` em qualquer plano — inclusive no Enterprise,
 * cujo ICP declarado existe justamente para ter várias.
 *
 * A escrita e a leitura montam sobre o **mesmo** `OrganizationLimitService`, e é
 * o que o último bloco deste arquivo cobra: a tela pergunta antes de mostrar o
 * botão, e uma segunda cópia da regra responderia diferente no primeiro ajuste
 * de packaging.
 */
function build(options: {
  planType?: string | null;
  owned?: number;
  negotiatedOrganizations?: number | null;
}) {
  const {
    planType = 'PRO',
    owned = 0,
    negotiatedOrganizations = null,
  } = options;

  const organizationsRepository = {
    findByOwnerId: jest
      .fn()
      .mockResolvedValue(owned > 0 ? { id: 'org-ref' } : null),
    countByOwnerId: jest.fn().mockResolvedValue(owned),
    // Uma escrita, não duas: organização, configuração de ads, participação
    // OWNER e assinatura nascem na mesma transação do repositório.
    saveWithOwner: jest.fn().mockResolvedValue(undefined),
  };

  const organizationUsersRepository = { save: jest.fn() };
  const accountsRepository = {
    findById: jest.fn().mockResolvedValue({ id: 'acc-1' }),
  };
  const auditLog = { record: jest.fn() };
  const organizationPlan = {
    findPlanTypeByOrganizationId: jest.fn().mockResolvedValue(planType),
  };
  const quotas = {
    findOverrides: jest.fn().mockResolvedValue({
      adAccounts: null,
      monitoredAds: null,
      seats: null,
      organizations: negotiatedOrganizations,
    }),
  };

  const plans = {
    findByType: jest
      .fn()
      .mockImplementation((type: string) =>
        Promise.resolve(
          type === 'FREE'
            ? { id: 'plan-free', trialDays: 14 }
            : { id: `plan-${type.toLowerCase()}`, trialDays: null },
        ),
      ),
  };

  const limits = new OrganizationLimitService(
    organizationsRepository as never,
    organizationPlan as never,
    quotas as never,
  );

  return {
    service: new CreateOrganizationUseCase(
      organizationsRepository as never,
      organizationUsersRepository as never,
      accountsRepository as never,
      auditLog as never,
      limits,
      plans as never,
    ),
    allowance: new GetOrganizationCreationAllowanceUseCase(limits),
    organizationsRepository,
    plans,
  };
}

const input = { name: 'Nova' } as never;

describe('quantas organizações uma conta pode possuir', () => {
  it('a primeira nunca consulta plano — não há contrato de referência ainda', async () => {
    const h = build({ owned: 0 });

    await expect(h.service.execute(input, 'acc-1')).resolves.toBeDefined();
    expect(h.organizationsRepository.countByOwnerId).not.toHaveBeenCalled();
  });

  it('o Profissional para na primeira', async () => {
    const h = build({ planType: 'PRO', owned: 1 });

    await expect(h.service.execute(input, 'acc-1')).rejects.toMatchObject({
      code: 'PLAN_FEATURE_NOT_INCLUDED',
    });
  });

  it('a recusa aponta para onde ir, em vez de dizer "já existe"', async () => {
    // `ORGANIZATION_ALREADY_EXISTS` descrevia o schema, não o negócio: quem
    // batia nele não sabia que havia um plano que resolvia.
    const h = build({ planType: 'PRO', owned: 1 });

    await expect(h.service.execute(input, 'acc-1')).rejects.toMatchObject({
      category: 'PLAN_LIMITED',
      details: { upgradeTo: 'Enterprise' },
    });
  });

  it('o Enterprise vai até o piso do plano', async () => {
    await expect(
      build({ planType: 'ENTERPRISE', owned: 4 }).service.execute(
        input,
        'acc-1',
      ),
    ).resolves.toBeDefined();

    await expect(
      build({ planType: 'ENTERPRISE', owned: 5 }).service.execute(
        input,
        'acc-1',
      ),
    ).rejects.toMatchObject({ code: 'PLAN_FEATURE_NOT_INCLUDED' });
  });

  it('o teto negociado vence o piso do plano', async () => {
    const h = build({
      planType: 'ENTERPRISE',
      owned: 12,
      negotiatedOrganizations: 30,
    });

    await expect(h.service.execute(input, 'acc-1')).resolves.toBeDefined();
  });
});

/**
 * Com que plano a organização nasce.
 *
 * A ausência desta linha era o defeito: `findPlanTypeByOrganizationId` lê
 * `organization_subscriptions`, e uma organização sem ela resolve para plano
 * nulo — `planAllows` fecha na dúvida e as dezesseis chaves de
 * `ENFORCED_FEATURE_KEYS` passam a recusar tudo.
 */
describe('o plano com que a nova organização nasce', () => {
  it('a primeira nasce no teste gratuito', async () => {
    const h = build({ owned: 0 });

    await h.service.execute(input, 'acc-1');

    const [, , subscription] =
      h.organizationsRepository.saveWithOwner.mock.calls[0];
    expect(subscription.planId).toBe('plan-free');
    expect(subscription.status).toBe('TRIALING');
    expect(subscription.trialEndsAt).toBeInstanceOf(Date);
  });

  it('a segunda herda o contrato da organização de referência', async () => {
    // Só o Enterprise chega aqui com uma segunda — a cota é 1 nos demais. Um
    // teste de 14 dias bloquearia no dia 15 a carteira que o cliente paga.
    const h = build({ planType: 'ENTERPRISE', owned: 1 });

    await h.service.execute(input, 'acc-1');

    const [, , subscription] =
      h.organizationsRepository.saveWithOwner.mock.calls[0];
    expect(subscription.planId).toBe('plan-enterprise');
    expect(subscription.status).toBe('ACTIVE');
    expect(subscription.trialEndsAt).toBeNull();
  });
});

/**
 * A pergunta e a escrita não podem discordar.
 *
 * `GET /organizations/creation-allowance` existe para a tela decidir se mostra
 * o botão de criar. Se ele respondesse por conta própria, o front voltaria a
 * ter duas maneiras de errar: mostrar o botão para quem será recusado — que é o
 * defeito original — ou escondê-lo de um Enterprise cujo teto foi negociado e
 * não está publicado em catálogo nenhum.
 */
describe('a leitura responde exatamente o que a escrita decidiria', () => {
  const cases = [
    { name: 'a primeira organização da conta', options: { owned: 0 } },
    {
      name: 'o Profissional na segunda',
      options: { planType: 'PRO', owned: 1 },
    },
    {
      name: 'o Individual na segunda',
      options: { planType: 'STARTER', owned: 1 },
    },
    {
      name: 'o teste gratuito espelhando o PRO',
      options: { planType: 'FREE', owned: 1 },
    },
    {
      name: 'o Enterprise dentro do piso',
      options: { planType: 'ENTERPRISE', owned: 4 },
    },
    {
      name: 'o Enterprise no piso',
      options: { planType: 'ENTERPRISE', owned: 5 },
    },
    {
      name: 'o teto negociado acima do piso',
      options: {
        planType: 'ENTERPRISE',
        owned: 12,
        negotiatedOrganizations: 30,
      },
    },
    {
      name: 'o teto negociado abaixo do piso',
      options: { planType: 'ENTERPRISE', owned: 2, negotiatedOrganizations: 2 },
    },
  ] as const;

  it.each(cases)('$name', async ({ options }) => {
    const read = await build({ ...options }).allowance.execute('acc-1');

    const write = build({ ...options })
      .service.execute(input, 'acc-1')
      .then(() => true)
      .catch(() => false);

    expect(read.allowed).toBe(await write);
  });

  it('a recusa já traz o teto, o uso e para onde ir - o modal não precisa tentar', async () => {
    const h = build({ planType: 'PRO', owned: 1 });

    await expect(h.allowance.execute('acc-1')).resolves.toEqual({
      allowed: false,
      used: 1,
      limit: 1,
      planLabel: 'Profissional',
      upgradeTo: 'Enterprise',
    });
  });

  it('o teto negociado vale para a tela, e não está em catálogo nenhum', async () => {
    // É o caso que o front não teria como responder sozinho: mesmo plano, mesmo
    // catálogo, respostas opostas - só o contrato da organização as separa.
    const piso = await build({
      planType: 'ENTERPRISE',
      owned: 5,
    }).allowance.execute('acc-1');

    const negociado = await build({
      planType: 'ENTERPRISE',
      owned: 5,
      negotiatedOrganizations: 20,
    }).allowance.execute('acc-1');

    expect(piso).toMatchObject({ allowed: false, limit: 5 });
    expect(negociado).toMatchObject({ allowed: true, limit: 20 });
  });

  it('sem organização de referência não há teto nem plano a declarar', async () => {
    await expect(
      build({ owned: 0 }).allowance.execute('acc-1'),
    ).resolves.toEqual({
      allowed: true,
      used: 0,
      limit: null,
      planLabel: null,
      upgradeTo: null,
    });
  });
});
