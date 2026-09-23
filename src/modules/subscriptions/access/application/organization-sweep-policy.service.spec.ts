import { Logger } from '@nestjs/common';
import {
  OrganizationSweepRepositoryInterface,
  OrganizationSweepSnapshot,
} from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import { OrganizationSweepPolicyService } from './organization-sweep-policy.service';

/**
 * A política que decide quem os jobs varrem — e o carimbo que ancora a janela.
 *
 * O carimbo é o que torna a promessa verificável: sem ele, "48h depois do
 * fechamento" não teria de onde contar, porque nada no banco guarda quando o
 * acesso fechou.
 */

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;
const AGORA = new Date('2026-09-14T12:00:00Z');

class FakeSweepRepository extends OrganizationSweepRepositoryInterface {
  snapshots = new Map<string, OrganizationSweepSnapshot>();
  marked: Array<{ ids: string[]; at: Date }> = [];
  cleared: string[][] = [];
  lookups = 0;

  async findSnapshots(ids: readonly string[]) {
    this.lookups += 1;
    return ids
      .map((id) => this.snapshots.get(id))
      .filter((item): item is OrganizationSweepSnapshot => item !== undefined);
  }

  async markAccessClosed(ids: readonly string[], at: Date) {
    this.marked.push({ ids: [...ids], at });
  }

  async clearAccessClosed(ids: readonly string[]) {
    this.cleared.push([...ids]);
  }
}

function organizacao(
  overrides: Partial<OrganizationSweepSnapshot> = {},
): OrganizationSweepSnapshot {
  return {
    organizationId: 'org-1',
    deletedAt: null,
    accessClosedAt: null,
    subscription: { status: 'ACTIVE', trialEndsAt: null, contract: null },
    accounts: [],
    ...overrides,
  };
}

const VENCIDA = {
  status: 'EXPIRED' as const,
  trialEndsAt: null,
  contract: null,
};

function contratoEmAtraso(diasDeAtraso: number) {
  return {
    status: 'ACTIVE' as const,
    trialEndsAt: null,
    contract: {
      status: 'ACTIVE',
      startsAt: new Date(AGORA.getTime() - 60 * DIA),
      endsAt: new Date(AGORA.getTime() + 300 * DIA),
      gracePeriodDays: 7,
      oldestUnpaidDueAt: new Date(AGORA.getTime() - diasDeAtraso * DIA),
    },
  };
}

function harness(...snapshots: OrganizationSweepSnapshot[]) {
  const repository = new FakeSweepRepository();
  for (const snapshot of snapshots) {
    repository.snapshots.set(snapshot.organizationId, snapshot);
  }

  const env = { get: jest.fn().mockReturnValue(true) };
  const service = new OrganizationSweepPolicyService(repository, env as never);

  return { repository, service };
}

describe('a política de varredura por organização', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('acesso aberto varre tudo e não carimba nada', async () => {
    const h = harness(organizacao());

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('FULL');
    expect(h.repository.marked).toEqual([]);
    expect(h.repository.cleared).toEqual([]);
  });

  it('carimba o fechamento na primeira vez que o observa, e abre a janela', async () => {
    const h = harness(organizacao({ subscription: VENCIDA }));

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('DAILY_SYNC_ONLY');
    expect(h.repository.marked).toEqual([{ ids: ['org-1'], at: AGORA }]);
  });

  it('não recarimba: a janela conta do primeiro carimbo', async () => {
    const h = harness(
      organizacao({
        subscription: VENCIDA,
        accessClosedAt: new Date(AGORA.getTime() - 47 * HORA),
      }),
    );

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('DAILY_SYNC_ONLY');
    expect(h.repository.marked).toEqual([]);
  });

  it('passadas 48h do carimbo, a organização sai de todas as varreduras', async () => {
    const h = harness(
      organizacao({
        subscription: VENCIDA,
        accessClosedAt: new Date(AGORA.getTime() - 49 * HORA),
      }),
    );

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('NONE');
    expect(h.repository.marked).toEqual([]);
  });

  it('acesso que volta limpa o carimbo', async () => {
    const h = harness(
      organizacao({ accessClosedAt: new Date(AGORA.getTime() - 3 * DIA) }),
    );

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('FULL');
    expect(h.repository.cleared).toEqual([['org-1']]);
  });

  it('Enterprise dentro da tolerância segue varrido por inteiro, sem carimbo', async () => {
    const h = harness(organizacao({ subscription: contratoEmAtraso(5) }));

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('FULL');
    expect(h.repository.marked).toEqual([]);
  });

  it('Enterprise além da tolerância entra na janela de sync diário', async () => {
    const h = harness(organizacao({ subscription: contratoEmAtraso(9) }));

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('DAILY_SYNC_ONLY');
    expect(h.repository.marked).toEqual([{ ids: ['org-1'], at: AGORA }]);
  });

  it('um membro com assinatura pessoal ativa mantém a organização aberta', async () => {
    const h = harness(
      organizacao({
        subscription: VENCIDA,
        accounts: [
          {
            billingStatus: 'ACTIVE',
            accessStatus: 'ALLOWED',
            gracePeriodEndsAt: null,
            planType: 'PRO',
            expiresAt: new Date(AGORA.getTime() + 30 * DIA),
          },
        ],
      }),
    );

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('FULL');
  });

  it('organização excluída não é varrida, e o carimbo não é tocado', async () => {
    const h = harness(
      organizacao({
        subscription: VENCIDA,
        deletedAt: new Date(AGORA.getTime() - DIA),
      }),
    );

    const modes = await h.service.modesFor(['org-1'], AGORA);

    expect(modes.get('org-1')).toBe('NONE');
    expect(h.repository.marked).toEqual([]);
    expect(h.repository.cleared).toEqual([]);
  });

  it('organização que não existe mais não é varrida', async () => {
    const h = harness();

    const modes = await h.service.modesFor(['org-sumiu'], AGORA);

    expect(modes.get('org-sumiu')).toBe('NONE');
  });

  it('sem organizações, não consulta o banco', async () => {
    const h = harness();

    const modes = await h.service.modesFor([], AGORA);

    expect(modes.size).toBe(0);
    expect(h.repository.lookups).toBe(0);
  });

  it('filtra itens pela organização de cada um, pelos modos aceitos', async () => {
    const h = harness(
      organizacao({ organizationId: 'org-aberta' }),
      organizacao({ organizationId: 'org-fechada', subscription: VENCIDA }),
    );
    const itens = [
      { id: 'a', organizationId: 'org-aberta' },
      { id: 'b', organizationId: 'org-fechada' },
      { id: 'c', organizationId: 'org-aberta' },
    ];

    const completa = await h.service.keepByMode(
      itens,
      (item) => item.organizationId,
      ['FULL'],
      AGORA,
    );
    const diaria = await h.service.keepByMode(
      itens,
      (item) => item.organizationId,
      ['FULL', 'DAILY_SYNC_ONLY'],
      AGORA,
    );

    expect(completa.kept.map((item) => item.id)).toEqual(['a', 'c']);
    expect(completa.skipped).toBe(1);
    expect(diaria.kept.map((item) => item.id)).toEqual(['a', 'b', 'c']);
  });
});
