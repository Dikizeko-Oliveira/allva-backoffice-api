import { Logger } from '@nestjs/common';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import {
  OrganizationSweepRepositoryInterface,
  OrganizationSweepSnapshot,
} from 'src/modules/subscriptions/access/domain/ports/organization-sweep.repository';
import { CreativeThumbnailScheduler } from './creative-thumbnail.scheduler';

/**
 * O gatilho que faltava para `CreativeThumbnailService.backfill` — o serviço e
 * o extrator já tinham suíte própria; o que se prova aqui é só a decisão de
 * "para quem" e "quando não fazer nada", com a política de acesso de verdade
 * e um dublê do repositório.
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

function harness(
  input: {
    organizationIds?: string[];
    videoPreviewEnabled?: boolean;
  } = {},
) {
  const sweep = new OrganizationSweepPolicyService(
    new FakeSweepRepository([
      organizacao('org-aberta'),
      // Fechada há três dias: fora de tudo, inclusive da janela de sync.
      organizacao('org-encerrada', {
        subscription: VENCIDA,
        accessClosedAt: new Date(Date.now() - 72 * HORA),
      }),
    ]),
    { get: () => true } as never,
  );

  const thumbnails = {
    listOrganizationsWithMissingThumbnail: jest
      .fn()
      .mockResolvedValue(
        input.organizationIds ?? ['org-aberta', 'org-encerrada'],
      ),
  };

  const backfillService = {
    backfill: jest.fn().mockResolvedValue({
      requested: 1,
      generated: 1,
      failed: 0,
      skippedDisabled: false,
    }),
  };

  const env = { get: () => input.videoPreviewEnabled ?? true };

  const scheduler = new CreativeThumbnailScheduler(
    thumbnails as never,
    backfillService as never,
    env as never,
    sweep,
  );

  return { scheduler, thumbnails, backfillService };
}

describe('CreativeThumbnailScheduler', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('roda o backfill só para organização com acesso aberto', async () => {
    const h = harness();

    await h.scheduler.backfillDaily();

    expect(h.backfillService.backfill).toHaveBeenCalledTimes(1);
    expect(h.backfillService.backfill).toHaveBeenCalledWith({
      organizationId: 'org-aberta',
    });
  });

  it('não consulta nem processa nada com VIDEO_PREVIEW_ENABLED=false', async () => {
    const h = harness({ videoPreviewEnabled: false });

    await h.scheduler.backfillDaily();

    expect(
      h.thumbnails.listOrganizationsWithMissingThumbnail,
    ).not.toHaveBeenCalled();
    expect(h.backfillService.backfill).not.toHaveBeenCalled();
  });

  it('não chama a política de acesso quando nenhuma organização tem miniatura faltando', async () => {
    const h = harness({ organizationIds: [] });

    await h.scheduler.backfillDaily();

    expect(h.backfillService.backfill).not.toHaveBeenCalled();
  });
});
