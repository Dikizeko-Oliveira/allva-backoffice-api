import { Logger } from '@nestjs/common';
import { MembershipFreezeService } from './membership-freeze.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

const DAY = 24 * 60 * 60 * 1000;

/** Dono + 2 admins + 1 analista + 6 visualizadores = 10 assentos do Profissional. */
function members() {
  const rows = [
    { id: 'owner', role: 'OWNER', days: 400 },
    { id: 'admin-antigo', role: 'ADMIN', days: 300 },
    { id: 'admin-novo', role: 'ADMIN', days: 10 },
    { id: 'analista', role: 'ANALYST', days: 350 },
  ];

  for (let i = 0; i < 6; i += 1) {
    rows.push({ id: `viewer-${i}`, role: 'VIEWER', days: 380 - i });
  }

  return rows.map((row) => ({
    id: row.id,
    accountId: `acc-${row.id}`,
    role: row.role,
    createdAt: new Date(Date.now() - row.days * DAY),
    user: { name: row.id, email: `${row.id}@x.com` },
  }));
}

function buildService(rows = members()) {
  const updateMany = jest.fn().mockResolvedValue({ count: 0 });
  const prisma = {
    organizationUser: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany,
    },
    $transaction: jest.fn().mockResolvedValue([{ count: 0 }, { count: 0 }]),
  };

  return {
    service: new MembershipFreezeService(prisma as never),
    prisma,
    updateMany,
  };
}

const EFFECTIVE = new Date('2026-09-01T00:00:00.000Z');

async function previewFor(
  planType: 'STARTER' | 'PRO' | 'ENTERPRISE',
  chosen?: string[],
) {
  const { service } = buildService();
  return service.preview({
    organizationId: 'org-1',
    targetPlanType: planType,
    effectiveAt: EFFECTIVE,
    keepActiveMembershipIds: chosen,
  });
}

describe('quem mantém acesso quando os assentos encolhem', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('o dono nunca é congelado e ocupa um assento', async () => {
    const preview = await previewFor('STARTER');

    expect(preview.protectedSeats.map((s) => s.membershipId)).toEqual([
      'owner',
    ]);
    expect(preview.freezing).not.toContain('owner');
    // Individual tem 3 assentos; o dono consome um, sobram 2 para escolher.
    expect(preview.keeping).toHaveLength(2);
  });

  it('o default mantém os papéis mais graduados, e desempata por antiguidade', async () => {
    const preview = await previewFor('STARTER');

    // Ordenar só por antiguidade congelaria os dois admins para preservar
    // visualizadores mais velhos — o default que o suporte ouviria reclamar.
    expect(preview.keeping).toEqual(['admin-antigo', 'admin-novo']);
  });

  it('congela todos os que não couberam', async () => {
    const preview = await previewFor('STARTER');

    expect(preview.freezing).toHaveLength(7);
    expect(preview.freezing).toContain('analista');
  });

  it('a escolha do usuário substitui o default', async () => {
    const preview = await previewFor('STARTER', ['analista', 'viewer-0']);

    expect(preview.keeping).toEqual(['analista', 'viewer-0']);
    expect(preview.freezing).toContain('admin-antigo');
  });

  it('plano ilimitado não congela ninguém', async () => {
    const preview = await previewFor('ENTERPRISE');

    expect(preview.freezing).toEqual([]);
  });

  it('convite pendente não ocupa assento no congelamento', async () => {
    const { service, prisma } = buildService();

    await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    // Congelar quem já usa o produto para guardar a vaga de quem talvez nunca
    // apareça seria o pior dos dois lados.
    expect(prisma.organizationUser.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
  });
});

describe('a seleção de assentos é validada', () => {
  it('recusa tentar "manter" o dono — ele não é escolha', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    expect(() =>
      service.assertSelectionIsValid(preview, ['owner', 'admin-antigo']),
    ).toThrow(DomainError);
  });

  it('conta o assento do dono contra o teto', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    // 3 assentos, o dono ocupa 1: escolher 3 estoura.
    expect(() =>
      service.assertSelectionIsValid(preview, [
        'admin-antigo',
        'admin-novo',
        'analista',
      ]),
    ).toThrow(/permite 3 assentos/);
  });

  it('aceita uma seleção que cabe', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    expect(() =>
      service.assertSelectionIsValid(preview, ['analista', 'viewer-0']),
    ).not.toThrow();
  });
});

describe('carimbo e reversão de assentos', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('carimba a data futura — o cliente pagou o período', async () => {
    const { service, updateMany } = buildService();

    await service.apply({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    const freezeCall = updateMany.mock.calls.find(
      ([arg]) => (arg as { data: { frozenAt: Date | null } }).data.frozenAt,
    );
    expect(
      (freezeCall?.[0] as { data: { frozenAt: Date } }).data.frozenAt,
    ).toEqual(EFFECTIVE);
  });

  it('o upgrade devolve o acesso a todo mundo que o plano tirou', async () => {
    const { service, prisma } = buildService();
    prisma.organizationUser.updateMany.mockResolvedValue({ count: 7 });

    expect(await service.thawAll('org-1')).toBe(7);
    expect(prisma.organizationUser.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', frozenAt: { not: null } },
      data: { frozenAt: null },
    });
  });
});
