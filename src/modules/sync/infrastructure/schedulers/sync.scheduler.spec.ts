import { Logger } from '@nestjs/common';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import {
  OrganizationSweepRepositoryInterface,
  OrganizationSweepSnapshot,
} from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import { SyncScheduler } from './sync.scheduler';

/**
 * O que cada varredura do sync enfileira, por estado de acesso da organização.
 *
 * Usa a política de verdade, com o repositório em memória: o que se protege é a
 * combinação — cada cron pedindo o modo certo —, e um dublê da política provaria
 * só que o scheduler chama um método.
 */

const HORA = 60 * 60 * 1000;

class FakeSweepRepository extends OrganizationSweepRepositoryInterface {
  constructor(private readonly snapshots: OrganizationSweepSnapshot[]) {
    super();
  }

  async findSnapshots(ids: readonly string[]) {
    return this.snapshots.filter((item) => ids.includes(item.organizationId));
  }

  async markAccessClosed() {}

  async clearAccessClosed() {}
}

const VENCIDA = {
  status: 'EXPIRED' as const,
  trialEndsAt: null,
  contract: null,
};

function organizacao(
  organizationId: string,
  overrides: Partial<OrganizationSweepSnapshot> = {},
): OrganizationSweepSnapshot {
  return {
    organizationId,
    deletedAt: null,
    accessClosedAt: null,
    subscription: { status: 'ACTIVE', trialEndsAt: null, contract: null },
    accounts: [],
    ...overrides,
  };
}

function harness() {
  const now = Date.now();

  const sweep = new OrganizationSweepPolicyService(
    new FakeSweepRepository([
      organizacao('org-aberta'),
      // Fechou há uma hora: dentro da janela de sync diário.
      organizacao('org-na-janela', {
        subscription: VENCIDA,
        accessClosedAt: new Date(now - HORA),
      }),
      // Fechou há três dias: fora de tudo.
      organizacao('org-encerrada', {
        subscription: VENCIDA,
        accessClosedAt: new Date(now - 72 * HORA),
      }),
      organizacao('org-excluida', { deletedAt: new Date(now - HORA) }),
    ]),
    { get: () => true } as never,
  );

  const conta = (id: string, organizationId: string) => ({
    id,
    organizationId,
    lastSuccessfulFullSyncAt: new Date(now - 24 * HORA),
  });

  const accounts = {
    listSyncable: jest
      .fn()
      .mockResolvedValue([
        conta('conta-aberta', 'org-aberta'),
        conta('conta-na-janela', 'org-na-janela'),
        conta('conta-encerrada', 'org-encerrada'),
        conta('conta-excluida', 'org-excluida'),
      ]),
  };

  const integrations = {
    listAllConnected: jest.fn().mockResolvedValue([
      { id: 'int-aberta', organizationId: 'org-aberta' },
      { id: 'int-na-janela', organizationId: 'org-na-janela' },
    ]),
  };

  const dispatcher = {
    ingest: jest.fn(),
    reconcile: jest.fn(),
    discover: jest.fn(),
  };

  // Intervalo de 1h: toda hora é hora de ingest, e o que filtra é o acesso.
  const plans = { syncIntervalHoursFor: jest.fn().mockResolvedValue(1) };

  const scheduler = new SyncScheduler(
    accounts as never,
    integrations as never,
    dispatcher as never,
    { get: jest.fn().mockReturnValue(true) } as never,
    plans as never,
    {} as never,
    sweep,
  );

  return { scheduler, dispatcher };
}

function enfileiradas(mock: jest.Mock, campo: 'adAccountId' | 'integrationId') {
  return mock.mock.calls.map(
    ([job]) => (job as Record<typeof campo, string>)[campo],
  );
}

describe('o que o sync varre, por estado de acesso da organização', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('o ingest horário só passa por quem tem acesso', async () => {
    const h = harness();

    await h.scheduler.ingestIncremental();

    expect(enfileiradas(h.dispatcher.ingest, 'adAccountId')).toEqual([
      'conta-aberta',
    ]);
  });

  it('a varredura completa diária inclui quem está nas 48h depois do fechamento', async () => {
    const h = harness();

    await h.scheduler.ingestFull();

    expect(enfileiradas(h.dispatcher.ingest, 'adAccountId')).toEqual([
      'conta-aberta',
      'conta-na-janela',
    ]);
    for (const [job] of h.dispatcher.ingest.mock.calls) {
      expect(job).toMatchObject({ forceFullScan: true });
    }
  });

  it('a reconciliação só passa por quem tem acesso', async () => {
    const h = harness();

    await h.scheduler.reconcile();

    expect(enfileiradas(h.dispatcher.reconcile, 'adAccountId')).toEqual([
      'conta-aberta',
    ]);
  });

  it('a descoberta de contas só passa por quem tem acesso', async () => {
    const h = harness();

    await h.scheduler.discover();

    expect(enfileiradas(h.dispatcher.discover, 'integrationId')).toEqual([
      'int-aberta',
    ]);
  });
});
