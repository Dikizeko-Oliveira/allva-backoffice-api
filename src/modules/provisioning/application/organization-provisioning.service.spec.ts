import { Logger } from '@nestjs/common';
import { OrganizationProvisioningService } from './organization-provisioning.service';

/**
 * O serviço que fecha a costura entre um cadastro account-first e um produto
 * organization-first. O que precisa ser verdade:
 *
 *  1. quem já alcança uma organização não ganha outra — nem por posse, nem por
 *     participação, nem quando a participação está congelada por teto de plano;
 *  2. quem não alcança nenhuma nasce com organização, participação OWNER **e**
 *     assinatura, numa escrita só — a fronteira transacional é do repositório;
 *  3. o nome nunca sai vazio;
 *  4. a organização nunca nasce sem plano: era o que fazia `planAllows` fechar
 *     na dúvida e o produto recusar com `PLAN_FEATURE_NOT_INCLUDED` o que o
 *     cliente tinha contratado.
 */

function membership(
  organizationId: string,
  status: 'ACTIVE' | 'INVITED' = 'ACTIVE',
) {
  return { organizationId, status };
}

function buildHarness(
  options: {
    memberships?: { organizationId: string; status: string }[];
    aliveOrganizationIds?: string[];
    owned?: { id: string } | null;
    freePlan?: { id: string; trialDays: number | null } | null;
  } = {},
) {
  const organizations = {
    saveWithOwner: jest.fn().mockResolvedValue(undefined),
    listByIds: jest
      .fn()
      .mockResolvedValue(
        (options.aliveOrganizationIds ?? []).map((id) => ({ id })),
      ),
    findByOwnerId: jest.fn().mockResolvedValue(options.owned ?? null),
  };

  const organizationUsers = {
    listByAccountId: jest.fn().mockResolvedValue(options.memberships ?? []),
  };

  const auditLog = { record: jest.fn().mockResolvedValue(undefined) };

  const plans = {
    findByType: jest
      .fn()
      .mockResolvedValue(
        options.freePlan === null
          ? null
          : (options.freePlan ?? { id: 'plan-free', trialDays: 14 }),
      ),
  };

  return {
    service: new OrganizationProvisioningService(
      organizations as never,
      organizationUsers as never,
      plans as never,
      auditLog as never,
    ),
    organizations,
    organizationUsers,
    plans,
    auditLog,
  };
}

const account = {
  accountId: 'acc-1',
  accountName: 'Dikezeko Oliveira',
  accountEmail: 'dike@empresa.com',
  source: 'signup' as const,
};

describe('garantir a organização de uma conta', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('nasce com organização, participação OWNER e plano numa escrita só', async () => {
    const h = buildHarness();

    const result = await h.service.ensureForAccount(account);

    expect(result.created).toBe(true);
    expect(h.organizations.saveWithOwner).toHaveBeenCalledTimes(1);

    const [organization, owner, subscription] =
      h.organizations.saveWithOwner.mock.calls[0];
    expect(organization.id).toBe(result.organizationId);
    expect(organization.ownerId).toBe('acc-1');
    expect(organization.name).toBe('Dikezeko Oliveira');

    // Sem a participação, o dono não teria permissão na própria organização: é
    // ela que o RBAC lê, não `owner_id`.
    expect(owner.organizationId).toBe(result.organizationId);
    expect(owner.accountId).toBe('acc-1');
    expect(owner.role).toBe('OWNER');
    expect(owner.status).toBe('ACTIVE');

    /**
     * A terceira asserção é a que faltava, e é o defeito que este teste passou a
     * cobrir: `findPlanTypeByOrganizationId` lê exatamente esta linha, e sem ela
     * `planAllows` fecha na dúvida — o produto respondia "o plano atual não
     * inclui plataformas" a quem estava vinculando a primeira conta da Meta.
     */
    expect(subscription.organizationId).toBe(result.organizationId);
    expect(subscription.planId).toBe('plan-free');
    expect(subscription.status).toBe('TRIALING');
    expect(subscription.trialEndsAt).toBeInstanceOf(Date);
  });

  it('recusa criar organização quando não há plano FREE configurado', async () => {
    // Falhar alto é melhor que uma organização silenciosamente inútil: o
    // cadastro trata a exceção como best-effort e `provision:organizations` cura
    // o que ficou para trás.
    const h = buildHarness({ freePlan: null });

    await expect(h.service.ensureForAccount(account)).rejects.toMatchObject({
      response: { code: 'PLAN_NOT_CONFIGURED' },
    });
    expect(h.organizations.saveWithOwner).not.toHaveBeenCalled();
  });

  it('registra organization.created e owner.created', async () => {
    const h = buildHarness();

    await h.service.ensureForAccount(account);

    expect(h.auditLog.record.mock.calls.map(([entry]) => entry.event)).toEqual([
      'organization.created',
      'owner.created',
    ]);
    expect(h.auditLog.record.mock.calls[0][0].metadata).toMatchObject({
      source: 'signup',
      name: 'Dikezeko Oliveira',
    });
  });

  it('deriva o nome quando o da conta é inutilizável', async () => {
    const h = buildHarness();

    await h.service.ensureForAccount({ ...account, accountName: '   ' });

    expect(h.organizations.saveWithOwner.mock.calls[0][0].name).toBe('dike');
  });

  it('não cria nada para quem já possui uma organização', async () => {
    const h = buildHarness({ owned: { id: 'org-propria' } });

    const result = await h.service.ensureForAccount(account);

    expect(result).toEqual({ organizationId: 'org-propria', created: false });
    expect(h.organizations.saveWithOwner).not.toHaveBeenCalled();
    expect(h.auditLog.record).not.toHaveBeenCalled();
  });

  it('reusa a organização de quem convidou, em vez de criar uma vazia', async () => {
    // Um analista de agência já pertence à organização do convite. Criar uma
    // segunda poria no seletor de workspace algo que ninguém pediu e queimaria a
    // cota `organizations` do plano dele, que é 1 fora do Enterprise.
    const h = buildHarness({
      memberships: [membership('org-da-agencia')],
      aliveOrganizationIds: ['org-da-agencia'],
    });

    const result = await h.service.ensureForAccount(account);

    expect(result).toEqual({
      organizationId: 'org-da-agencia',
      created: false,
    });
    expect(h.organizations.saveWithOwner).not.toHaveBeenCalled();
  });

  it('participação congelada conta como pertencer', async () => {
    /**
     * `isActive()` recusa quem `frozen_at` alcançou, e é por isso que
     * `OwnerScopeResolverService` ignora essa participação. Herdar a recusa aqui
     * criaria uma organização nova para quem acabou de perder a vaga por
     * downgrade de plano — um contorno do teto de assentos produzido pelo
     * próprio provisionamento. O filtro é `status`, não `isActive()`.
     */
    const frozen = {
      organizationId: 'org-congelada',
      status: 'ACTIVE',
      isActive: () => false,
    };
    const h = buildHarness({
      memberships: [frozen],
      aliveOrganizationIds: ['org-congelada'],
    });

    const result = await h.service.ensureForAccount(account);

    expect(result.organizationId).toBe('org-congelada');
    expect(h.organizations.saveWithOwner).not.toHaveBeenCalled();
  });

  it('convite não aceito não conta como pertencer', async () => {
    // `INVITED` não passa em nenhum guard: tratá-la como pertencimento deixaria
    // a conta sem workspace utilizável.
    const h = buildHarness({
      memberships: [membership('org-do-convite', 'INVITED')],
      aliveOrganizationIds: ['org-do-convite'],
    });

    const result = await h.service.ensureForAccount(account);

    expect(result.created).toBe(true);
    expect(h.organizations.saveWithOwner).toHaveBeenCalledTimes(1);
  });

  it('participação cuja organização foi apagada não conta como pertencer', async () => {
    // A participação sobrevive ao soft delete da organização; a existência de
    // uma não prova a da outra.
    const h = buildHarness({
      memberships: [membership('org-apagada')],
      aliveOrganizationIds: [],
    });

    const result = await h.service.ensureForAccount(account);

    expect(result.created).toBe(true);
    expect(h.organizations.saveWithOwner).toHaveBeenCalledTimes(1);
  });
});
