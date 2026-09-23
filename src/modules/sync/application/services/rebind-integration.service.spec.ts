import { RebindIntegrationService } from './rebind-integration.service';
import { AdAccountsSyncRepositoryInterface } from '../../domain/ports/ad-accounts-sync.repository';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/**
 * ⑤ REBIND (§8.6, P10) — **a identidade do domínio não depende da credencial.**
 *
 * O que estes testes protegem é a ausência: reconectar não pode arquivar
 * anúncio, não pode resolver desperdício e não pode expirar recomendação. Perder
 * acesso a uma conta é evento de **visibilidade** — os anúncios continuam
 * existindo e gastando.
 */

function account(overrides: Record<string, unknown> = {}) {
  return {
    id: 'acc-conhecida',
    accountId: 'user-1',
    organizationId: 'org-1',
    platform: 'META' as const,
    externalAccountId: 'act_111',
    name: 'Conta',
    integrationId: 'int-antiga',
    integrationStatus: 'CONNECTED' as const,
    currency: 'BRL',
    timezone: 'UTC',
    attributionWindowDays: 7,
    restatementWindowDays: 14,
    syncHealth: 'HEALTHY' as const,
    syncHealthReason: null,
    unreachableSince: null,
    lastSuccessfulFullSyncAt: null,
    lastFullSyncAt: null,
    baseCurrency: 'BRL',
    currencyState: 'STABLE' as const,
    ...overrides,
  };
}

class FakeAccounts extends AdAccountsSyncRepositoryInterface {
  known = [account()];
  upserts: Array<Record<string, unknown>> = [];
  healthUpdates: Array<{ id: string; update: Record<string, unknown> }> = [];
  detached: string[] = [];
  listings: Array<Record<string, unknown> | undefined> = [];

  async findById() {
    return this.known[0];
  }
  async listSyncable(input?: Record<string, unknown>) {
    this.listings.push(input);
    return this.known;
  }
  async listByIntegration() {
    return this.known;
  }

  async upsertDiscovered(input: Record<string, unknown>) {
    this.upserts.push(input);
    const existing = this.known.find(
      (item) => item.externalAccountId === input.externalAccountId,
    );

    return existing
      ? { id: existing.id, created: false, rebound: true }
      : { id: 'acc-nova', created: true, rebound: false };
  }

  async updateHealth(id: string, update: Record<string, unknown>) {
    this.healthUpdates.push({ id, update });
  }
  async updateRestatementWindow() {}
  async detachIntegration(id: string) {
    this.detached.push(id);
  }
}

function buildRebind(
  accessible: Array<{ externalAccountId: string }>,
  options: { revokeFails?: boolean } = {},
) {
  const accounts = new FakeAccounts();
  const emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
  const audited: Array<Record<string, unknown>> = [];
  const revoked: string[] = [];
  const disconnected: string[] = [];

  const integrations = {
    findById: async (id: string) => ({
      id,
      organizationId: 'org-1',
      providerType: 'META',
      markDisconnected: () => disconnected.push(id),
    }),
    update: async () => undefined,
  };

  const providers = {
    for: () => ({
      listAdAccounts: async () =>
        accessible.map((item) => ({
          ...item,
          name: 'Conta',
          currency: 'BRL',
          timezone: 'UTC',
        })),
      revokeToken: async (integration: { id: string }) => {
        if (options.revokeFails) throw new Error('500 da plataforma');
        revoked.push(integration.id);
      },
    }),
  };

  const service = new RebindIntegrationService(
    accounts,
    integrations as never,
    providers as never,
    {
      record: async (input: Record<string, unknown>) => audited.push(input),
    } as never,
    {
      emitFrom: (
        _ctx: unknown,
        name: string,
        payload: Record<string, unknown>,
      ) => {
        emitted.push({ name, payload });
        return { eventId: 'evt' } as never;
      },
    } as never,
  );

  return { service, accounts, emitted, audited, revoked, disconnected };
}

const REQUEST = {
  organizationId: 'org-1',
  accountId: 'user-1',
  platform: 'META' as const,
  integrationId: 'int-nova',
  ctx: createRootJobContext(),
  actorId: 'user-1',
};

describe('rebind preservando identidade (§8.6, P10)', () => {
  it('religa a conta conhecida pela identidade, não pela credencial', async () => {
    const h = buildRebind([{ externalAccountId: 'act_111' }]);

    const outcome = await h.service.execute(REQUEST);

    expect(outcome.reboundAdAccountIds).toEqual(['acc-conhecida']);
    expect(outcome.createdAdAccountIds).toEqual([]);
    // O casamento é por `(organizationId, platform, externalAccountId)`.
    expect(h.accounts.upserts[0]).toMatchObject({
      organizationId: 'org-1',
      platform: 'META',
      externalAccountId: 'act_111',
      integrationId: 'int-nova',
    });
  });

  it('conta nova entra; a antiga não é tocada', async () => {
    const h = buildRebind([
      { externalAccountId: 'act_111' },
      { externalAccountId: 'act_222' },
    ]);

    const outcome = await h.service.execute(REQUEST);

    expect(outcome.createdAdAccountIds).toEqual(['acc-nova']);
    expect(outcome.unreachableAdAccountIds).toEqual([]);
  });

  it('conta inacessível vira UNREACHABLE e **nada é arquivado**', async () => {
    // A credencial nova não alcança `act_111`. Os anúncios continuam existindo e
    // gastando: arquivar aqui destruiria justamente o histórico que P10 preserva.
    const h = buildRebind([{ externalAccountId: 'act_999' }]);

    const outcome = await h.service.execute(REQUEST);

    expect(outcome.unreachableAdAccountIds).toEqual(['acc-conhecida']);
    expect(h.accounts.healthUpdates[0]).toMatchObject({
      id: 'acc-conhecida',
      update: { health: 'UNREACHABLE', reason: 'ACCOUNT_NOT_ACCESSIBLE' },
    });
    // A ausência é a entrega: nenhuma conta foi desvinculada nem apagada.
    expect(h.accounts.detached).toEqual([]);
  });

  it('considera também as contas presas a uma credencial vencida', async () => {
    // Reconectar é o caminho de volta do token vencido: sem estas contas, o
    // rebind não saberia quem a credencial nova deixou de alcançar.
    const h = buildRebind([{ externalAccountId: 'act_111' }]);

    await h.service.execute(REQUEST);

    expect(h.accounts.listings[0]).toMatchObject({
      organizationId: 'org-1',
      credential: 'ANY_LINKED',
    });
  });

  it('falha ao listar não vira "nenhuma conta acessível"', async () => {
    // Seria arquivar a organização inteira por indisponibilidade momentânea.
    const accounts = new FakeAccounts();
    const service = new RebindIntegrationService(
      accounts,
      {
        findById: async () => ({ id: 'int-nova', organizationId: 'org-1' }),
      } as never,
      {
        for: () => ({
          listAdAccounts: async () => {
            throw new Error('502 do Graph');
          },
        }),
      } as never,
      { record: async () => undefined } as never,
      { emitFrom: () => ({}) } as never,
    );

    await expect(service.execute(REQUEST)).rejects.toBeInstanceOf(DomainError);
    expect(accounts.healthUpdates).toEqual([]);
  });

  it('emite integration.rebound e registra na auditoria', async () => {
    const h = buildRebind([{ externalAccountId: 'act_111' }]);

    await h.service.execute(REQUEST);

    expect(h.emitted.map((event) => event.name)).toContain(
      'integration.rebound',
    );
    expect(h.audited[0]).toMatchObject({
      event: 'integration.rebound',
      entityId: 'int-nova',
      organizationId: 'org-1',
    });
  });

  it('a credencial antiga é revogada, mas a linha sobrevive para auditoria', async () => {
    const h = buildRebind([{ externalAccountId: 'act_111' }]);

    await h.service.execute(REQUEST);

    expect(h.revoked).toEqual(['int-antiga']);
    expect(h.disconnected).toEqual(['int-antiga']);
  });

  it('a credencial antiga sai de CONNECTED mesmo quando a revogação falha', async () => {
    // Substituída ela foi de qualquer jeito. Conectada, manteria no ingest de
    // hora em hora as contas que a credencial nova não alcança.
    const h = buildRebind([{ externalAccountId: 'act_111' }], {
      revokeFails: true,
    });

    await h.service.execute(REQUEST);

    expect(h.revoked).toEqual([]);
    expect(h.disconnected).toEqual(['int-antiga']);
  });
});
