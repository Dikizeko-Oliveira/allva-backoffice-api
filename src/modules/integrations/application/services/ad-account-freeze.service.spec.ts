import { Logger } from '@nestjs/common';
import { AdAccountFreezeService } from './ad-account-freeze.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** Cinco contas: três Meta, uma Google, uma TikTok — ordenadas por gasto. */
const ROWS = [
  { id: 'meta-alta', name: 'Meta A', platform: 'META', spend_base: 9000 },
  { id: 'tiktok', name: 'TikTok', platform: 'TIKTOK', spend_base: 5000 },
  { id: 'meta-media', name: 'Meta B', platform: 'META', spend_base: 3000 },
  { id: 'google', name: 'Google', platform: 'GOOGLE', spend_base: 800 },
  { id: 'meta-baixa', name: 'Meta C', platform: 'META', spend_base: 0 },
];

function buildService(rows = ROWS) {
  const updateMany = jest.fn().mockReturnValue({ count: 0 });
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(rows),
    $transaction: jest.fn().mockResolvedValue([{ count: 0 }, { count: 0 }]),
    adAccount: { updateMany },
  };

  return {
    service: new AdAccountFreezeService(prisma as never),
    prisma,
    updateMany,
  };
}

const EFFECTIVE = new Date('2026-09-01T00:00:00.000Z');

describe('quem fica ativo quando o plano encolhe', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('mantém as que mais gastam, até o teto do plano', async () => {
    const { service } = buildService();

    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    // Individual: 2 contas, Meta + Google. TikTok sai por plataforma, e entre as
    // quatro restantes ficam as duas de maior gasto.
    expect(preview.keeping).toEqual(['meta-alta', 'meta-media']);
  });

  it('conta de plataforma fora do plano congela e NÃO é escolhível', async () => {
    const { service } = buildService();

    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    expect(preview.forced.map((c) => c.adAccountId)).toEqual(['tiktok']);
    expect(preview.selectable.map((c) => c.adAccountId)).not.toContain(
      'tiktok',
    );
    expect(preview.freezing).toContain('tiktok');
  });

  it('a escolha do usuário substitui o default', async () => {
    const { service } = buildService();

    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
      keepActiveAdAccountIds: ['google', 'meta-baixa'],
    });

    expect(preview.keeping).toEqual(['google', 'meta-baixa']);
    expect(preview.freezing).toEqual(
      expect.arrayContaining(['meta-alta', 'meta-media', 'tiktok']),
    );
  });

  it('plano ilimitado não congela nada', async () => {
    const { service } = buildService();

    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'ENTERPRISE',
      effectiveAt: EFFECTIVE,
    });

    expect(preview.freezing).toEqual([]);
    expect(preview.keeping).toHaveLength(5);
  });

  it('conta sem série ainda disputa a vaga, por baixo', async () => {
    // `LEFT JOIN`: um `INNER` sumiria com a conta recém-vinculada em vez de
    // deixá-la competir no fim da fila.
    const { service } = buildService();

    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'PRO',
      effectiveAt: EFFECTIVE,
    });

    expect(preview.selectable.map((c) => c.adAccountId)).toContain(
      'meta-baixa',
    );
  });
});

describe('a seleção é validada antes de valer', () => {
  it('recusa manter conta de plataforma fora do plano', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    // Deixar "salvar" uma conta que o sistema vai congelar de qualquer jeito é
    // a pior forma de dizer não: dizer sim e não cumprir.
    expect(() =>
      service.assertSelectionIsValid(preview, ['tiktok', 'meta-alta']),
    ).toThrow(DomainError);
  });

  it('recusa seleção acima do teto', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    expect(() =>
      service.assertSelectionIsValid(preview, [
        'meta-alta',
        'meta-media',
        'google',
      ]),
    ).toThrow(/permite 2 contas ativas/);
  });

  it('aceita uma seleção legítima', async () => {
    const { service } = buildService();
    const preview = await service.preview({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    expect(() =>
      service.assertSelectionIsValid(preview, ['google', 'meta-baixa']),
    ).not.toThrow();
  });
});

describe('carimbo e reversão', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('carimba a data futura, não a de hoje', async () => {
    const { service, updateMany } = buildService();

    await service.apply({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    // O cliente pagou o período: congelar antes tiraria o que ele comprou.
    const freezeCall = updateMany.mock.calls.find(
      ([arg]) => (arg as { data: { frozenAt: Date | null } }).data.frozenAt,
    );
    expect(
      (freezeCall?.[0] as { data: { frozenAt: Date } }).data.frozenAt,
    ).toEqual(EFFECTIVE);
  });

  it('limpa o congelamento de quem fica — a escolha pode mudar na janela', async () => {
    const { service, updateMany } = buildService();

    await service.apply({
      organizationId: 'org-1',
      targetPlanType: 'STARTER',
      effectiveAt: EFFECTIVE,
    });

    const clearCall = updateMany.mock.calls.find(
      ([arg]) =>
        (arg as { data: { frozenAt: Date | null } }).data.frozenAt === null,
    );
    expect(clearCall).toBeDefined();
  });

  it('o upgrade descongela tudo', async () => {
    const { service, prisma } = buildService();
    prisma.adAccount.updateMany.mockResolvedValue({ count: 3 });

    const thawed = await service.thawAll('org-1');

    expect(thawed).toBe(3);
    expect(prisma.adAccount.updateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', frozenAt: { not: null } },
      data: { frozenAt: null },
    });
  });
});
