import { Injectable } from '@nestjs/common';
import { sweepableAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import {
  AdAccountHealthUpdate,
  AdAccountsSyncRepositoryInterface,
  DiscoveredAdAccount,
  SyncableAdAccount,
  UpsertedAdAccount,
} from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const ACCOUNT_SELECT = {
  id: true,
  accountId: true,
  organizationId: true,
  platform: true,
  externalAccountId: true,
  name: true,
  integrationId: true,
  currency: true,
  timezone: true,
  attributionWindowDays: true,
  restatementWindowDays: true,
  syncHealth: true,
  syncHealthReason: true,
  unreachableSince: true,
  lastSuccessfulFullSyncAt: true,
  lastFullSyncAt: true,
  integration: { select: { status: true } },
  organization: { select: { baseCurrency: true, currencyState: true } },
} as const;

type AccountRow = {
  id: string;
  accountId: string;
  organizationId: string;
  platform: string;
  externalAccountId: string;
  name: string;
  integrationId: string | null;
  currency: string;
  timezone: string;
  attributionWindowDays: number | null;
  restatementWindowDays: number;
  syncHealth: string;
  syncHealthReason: string | null;
  unreachableSince: Date | null;
  lastSuccessfulFullSyncAt: Date | null;
  lastFullSyncAt: Date | null;
  integration: { status: string } | null;
  organization: { baseCurrency: string; currencyState: string } | null;
};

@Injectable()
export class AdAccountsSyncPrismaRepository extends AdAccountsSyncRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findById(adAccountId: string): Promise<SyncableAdAccount | null> {
    const row = await this.prisma.adAccount.findUnique({
      where: { id: adAccountId },
      select: ACCOUNT_SELECT,
    });

    return row ? toDomain(row as unknown as AccountRow) : null;
  }

  async listSyncable(input?: {
    organizationId?: string;
    integrationId?: string;
    credential?: 'SYNCABLE' | 'ANY_LINKED';
  }): Promise<SyncableAdAccount[]> {
    const now = new Date();
    const rows = await this.prisma.adAccount.findMany({
      where: {
        AND: [
          input?.organizationId ? { organizationId: input.organizationId } : {},
          input?.integrationId ? { integrationId: input.integrationId } : {},
          /**
           * Conta congelada por plano não é sincronizada — é o que faz o teto
           * significar alguma coisa: sem isto, congelar não pouparia uma única
           * chamada à plataforma nem uma linha de métrica. `frozenAt` no futuro é
           * agendamento e **não** corta nada: o cliente pagou o período.
           *
           * Por padrão a credencial também precisa ainda se ler, e a organização
           * existir: token vencido ou integração desconectada não voltam sozinhos,
           * e tentar de hora em hora só gasta chamada de plataforma.
           * `ANY_LINKED` devolve também as presas a uma credencial morta — é o que
           * o rebind precisa, porque é por ele que elas saem desse estado.
           */
          input?.credential === 'ANY_LINKED'
            ? {
                integrationId: { not: null },
                OR: [{ frozenAt: null }, { frozenAt: { gt: now } }],
              }
            : sweepableAdAccountWhere(now),
        ],
      },
      select: ACCOUNT_SELECT,
      orderBy: { discoveredAt: 'asc' },
    });

    return (rows as unknown as AccountRow[]).map(toDomain);
  }

  /** Todas as contas presas à credencial, leia-se ela ou não. */
  async listByIntegration(integrationId: string): Promise<SyncableAdAccount[]> {
    return this.listSyncable({ integrationId, credential: 'ANY_LINKED' });
  }

  /**
   * Casa por `(organizationId, platform, externalAccountId)` — **nunca** por
   * `integrationId` (P10, §8.6).
   *
   * É esta unique que faz reconectar **repontuar** a credencial em vez de criar
   * uma conta paralela. Sem ela, cada reconexão duplicaria a hierarquia inteira
   * e o histórico do usuário ficaria dividido entre dois ids que ele não sabe
   * que existem.
   */
  async upsertDiscovered(
    account: DiscoveredAdAccount,
    options: { relinkDetached?: boolean } = {},
  ): Promise<UpsertedAdAccount> {
    const existing = await this.prisma.adAccount.findUnique({
      where: {
        organizationId_platform_externalAccountId: {
          organizationId: account.organizationId,
          platform: account.platform,
          externalAccountId: account.externalAccountId,
        },
      },
      select: { id: true, integrationId: true },
    });

    if (!existing) {
      const created = await this.prisma.adAccount.create({
        data: {
          accountId: account.accountId,
          organizationId: account.organizationId,
          platform: account.platform,
          externalAccountId: account.externalAccountId,
          name: account.name,
          currency: account.currency,
          timezone: account.timezone,
          integrationId: account.integrationId,
          attributionWindowDays: account.attributionWindowDays ?? null,
        },
        select: { id: true },
      });

      return { id: created.id, created: true, rebound: false };
    }

    /**
     * Conta desvinculada fica desvinculada.
     *
     * Desvincular — pela tela ou desconectando a integração — é decisão do
     * usuário, e a descoberta diária a desfazia: toda conta que a plataforma
     * ainda lista voltava a apontar para a credencial às 04:00, e o sync
     * recomeçava sozinho. Os dados cadastrais continuam atualizados; o vínculo
     * só volta por quem o pede — vincular de novo, ou o rebind.
     */
    if (existing.integrationId === null && options.relinkDetached === false) {
      await this.prisma.adAccount.update({
        where: { id: existing.id },
        data: {
          name: account.name,
          currency: account.currency,
          timezone: account.timezone,
        },
      });

      return { id: existing.id, created: false, rebound: false };
    }

    const rebound = existing.integrationId !== account.integrationId;

    await this.prisma.adAccount.update({
      where: { id: existing.id },
      data: {
        name: account.name,
        currency: account.currency,
        timezone: account.timezone,
        integrationId: account.integrationId,
        // Reconectar não conserta a saúde sozinho: quem declara `HEALTHY` é o
        // ingest seguinte, quando conseguir ver tudo. Marcar aqui diria que a
        // conta está em dia antes de qualquer leitura.
        ...(rebound ? { syncHealthReason: 'REBOUND_PENDING_INGEST' } : {}),
      },
    });

    return { id: existing.id, created: false, rebound };
  }

  async updateHealth(
    adAccountId: string,
    update: AdAccountHealthUpdate,
  ): Promise<void> {
    await this.prisma.adAccount.update({
      where: { id: adAccountId },
      data: {
        syncHealth: update.health,
        syncHealthReason: update.reason,
        unreachableSince: update.unreachableSince,
        ...(update.lastSuccessfulFullSyncAt !== undefined
          ? { lastSuccessfulFullSyncAt: update.lastSuccessfulFullSyncAt }
          : {}),
        ...(update.lastFullSyncAt !== undefined
          ? { lastFullSyncAt: update.lastFullSyncAt }
          : {}),
      },
    });
  }

  async updateRestatementWindow(
    adAccountId: string,
    input: {
      attributionWindowDays: number | null;
      restatementWindowDays: number;
    },
  ): Promise<void> {
    await this.prisma.adAccount.update({
      where: { id: adAccountId },
      data: {
        attributionWindowDays: input.attributionWindowDays,
        restatementWindowDays: input.restatementWindowDays,
      },
    });
  }

  async detachIntegration(adAccountId: string): Promise<void> {
    await this.prisma.adAccount.update({
      where: { id: adAccountId },
      data: {
        integrationId: null,
        syncHealth: 'UNREACHABLE',
        syncHealthReason: 'CREDENTIAL_MISSING',
        unreachableSince: new Date(),
      },
    });
  }
}

function toDomain(row: AccountRow): SyncableAdAccount {
  return {
    id: row.id,
    accountId: row.accountId,
    organizationId: row.organizationId,
    platform: row.platform as SyncableAdAccount['platform'],
    externalAccountId: row.externalAccountId,
    name: row.name,
    integrationId: row.integrationId,
    integrationStatus: (row.integration?.status ??
      null) as SyncableAdAccount['integrationStatus'],
    currency: row.currency,
    timezone: row.timezone,
    attributionWindowDays: row.attributionWindowDays,
    restatementWindowDays: row.restatementWindowDays,
    syncHealth: row.syncHealth as SyncableAdAccount['syncHealth'],
    syncHealthReason: row.syncHealthReason,
    unreachableSince: row.unreachableSince,
    lastSuccessfulFullSyncAt: row.lastSuccessfulFullSyncAt,
    lastFullSyncAt: row.lastFullSyncAt,
    // A moeda-base é da organização (R-M); sem ela a normalização não tem alvo,
    // e o fallback para a moeda da conta manteria o número correto na origem —
    // só incomparável entre contas, que é o problema que R-M resolve.
    baseCurrency: row.organization?.baseCurrency ?? row.currency,
    currencyState: row.organization?.currencyState ?? 'STABLE',
  } as SyncableAdAccount;
}
