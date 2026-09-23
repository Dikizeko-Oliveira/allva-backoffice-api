import { Injectable } from '@nestjs/common';
import {
  AdAccount,
  Integration,
} from 'src/modules/integrations/domain/entities';
import type {
  IntegrationStatus,
  ProviderType,
  SyncStatus,
} from 'src/modules/integrations/domain/entities/integration.entity';
import {
  IntegrationsRepositoryInterface,
  IntegrationWithAdAccounts,
} from 'src/modules/integrations/domain/ports';
import { Prisma } from 'generated/prisma/client';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { TokenCipherService } from 'src/shared/infrastructure/security/token-cipher.service';

type IntegrationRow = {
  id: string;
  name: string | null;
  accountId: string;
  organizationId: string;
  provider: string;
  providerType: ProviderType;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
  status: IntegrationStatus;
  syncStatus: SyncStatus;
  lastSyncAt: Date | null;
  syncError: string | null;
  disconnectedAt: Date | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type AdAccountRow = {
  id: string;
  integrationId: string | null;
  organizationId: string;
  accountId: string;
  platform: string;
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
  discoveredAt: Date;
  frozenAt: Date | null;
};

@Injectable()
export class IntegrationsPrismaRepository implements IntegrationsRepositoryInterface {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenCipher: TokenCipherService,
  ) {}

  private toEntity(row: IntegrationRow): Integration {
    return Integration.restore({
      id: row.id,
      name: row.name ?? undefined,
      accountId: row.accountId,
      organizationId: row.organizationId,
      provider: row.provider,
      providerType: row.providerType,
      accessToken: this.tokenCipher.decrypt(row.accessToken),
      refreshToken: row.refreshToken
        ? this.tokenCipher.decrypt(row.refreshToken)
        : undefined,
      expiresAt: row.expiresAt,
      status: row.status,
      syncStatus: row.syncStatus,
      lastSyncAt: row.lastSyncAt,
      syncError: row.syncError,
      disconnectedAt: row.disconnectedAt,
      metadata: (row.metadata as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  }

  private toAdAccountEntity(row: AdAccountRow): AdAccount {
    return AdAccount.restore({
      id: row.id,
      integrationId: row.integrationId,
      organizationId: row.organizationId,
      accountId: row.accountId,
      platform: row.platform,
      externalAccountId: row.externalAccountId,
      name: row.name,
      currency: row.currency,
      timezone: row.timezone,
      discoveredAt: row.discoveredAt,
      frozenAt: row.frozenAt,
    });
  }

  private buildWritePayload(integration: Integration) {
    return {
      id: integration.id,
      name: integration.name ?? null,
      accountId: integration.accountId,
      organizationId: integration.organizationId,
      provider: integration.provider,
      providerType: integration.providerType,
      accessToken: this.tokenCipher.encrypt(integration.accessToken),
      refreshToken: integration.refreshToken
        ? this.tokenCipher.encrypt(integration.refreshToken)
        : null,
      expiresAt: integration.expiresAt,
      status: integration.status,
      syncStatus: integration.syncStatus,
      lastSyncAt: integration.lastSyncAt ?? null,
      syncError: integration.syncError ?? null,
      disconnectedAt: integration.disconnectedAt ?? null,
      /**
       * `DbNull` — SQL NULL —, e não `null`.
       *
       * Numa coluna `Json?` o Prisma recusa `null` de propósito: ele não sabe se
       * o pedido é apagar a coluna (`DbNull`) ou gravar o literal JSON `null`
       * (`JsonNull`). Era este o mismatch que o `as never` calava, e junto com
       * ele calava a organização nula. `metadata: null` na leitura é SQL NULL,
       * então `DbNull` é o que fecha o ciclo.
       */
      metadata: integration.metadata
        ? toPrismaJson(integration.metadata)
        : Prisma.DbNull,
    };
  }

  /**
   * Sem `as never`. O cast estava aqui desde antes de `organization_id` virar
   * NOT NULL e era o que deixava `organizationId: null` compilar contra uma
   * coluna obrigatória — o INSERT só falhava em runtime, no meio do callback do
   * OAuth. Tipar o payload é o que faz o compilador cobrar a organização de
   * quem constrói a credencial.
   */
  async save(integration: Integration): Promise<void> {
    const payload = this.buildWritePayload(integration);
    await this.prisma.integration.create({
      data: {
        ...payload,
        createdAt: integration.createdAt,
        updatedAt: integration.updatedAt,
      },
    });
  }

  async update(integration: Integration): Promise<void> {
    const payload = this.buildWritePayload(integration);
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: {
        name: payload.name,
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: payload.expiresAt,
        status: payload.status,
        syncStatus: payload.syncStatus,
        lastSyncAt: payload.lastSyncAt,
        syncError: payload.syncError,
        disconnectedAt: payload.disconnectedAt,
        metadata: payload.metadata,
        updatedAt: integration.updatedAt,
      },
    });
  }

  async findById(id: string): Promise<Integration | null> {
    const record = await this.prisma.integration.findUnique({ where: { id } });
    if (!record) return null;
    return this.toEntity(record as unknown as IntegrationRow);
  }

  async findByAccountId(accountId: string): Promise<Integration | null> {
    const record = await this.prisma.integration.findFirst({
      where: { accountId },
    });
    if (!record) return null;
    return this.toEntity(record as unknown as IntegrationRow);
  }

  async findByOrganizationId(
    organizationId: string,
  ): Promise<Integration | null> {
    const record = await this.prisma.integration.findFirst({
      where: { organizationId },
    });
    if (!record) return null;
    return this.toEntity(record as unknown as IntegrationRow);
  }

  async findByAccountAndProvider(
    accountId: string,
    providerType: ProviderType,
  ): Promise<Integration | null> {
    const record = await this.prisma.integration.findFirst({
      where: { accountId, providerType },
    });
    if (!record) return null;
    return this.toEntity(record as unknown as IntegrationRow);
  }

  async listByAccountId(
    accountId: string,
  ): Promise<IntegrationWithAdAccounts[]> {
    const records = await this.prisma.integration.findMany({
      where: { accountId },
      include: { adAccounts: true },
    });
    return records.map((record) => ({
      integration: this.toEntity(record as unknown as IntegrationRow),
      adAccounts: (
        record as unknown as { adAccounts: AdAccountRow[] }
      ).adAccounts.map((adAccount) => this.toAdAccountEntity(adAccount)),
    }));
  }

  async listByOrganizationId(
    organizationId: string,
  ): Promise<IntegrationWithAdAccounts[]> {
    const records = await this.prisma.integration.findMany({
      where: { organizationId },
      include: { adAccounts: true },
    });
    return records.map((record) => ({
      integration: this.toEntity(record as unknown as IntegrationRow),
      adAccounts: (
        record as unknown as { adAccounts: AdAccountRow[] }
      ).adAccounts.map((adAccount) => this.toAdAccountEntity(adAccount)),
    }));
  }

  async listAllConnected(): Promise<Integration[]> {
    const records = await this.prisma.integration.findMany({
      where: { status: 'CONNECTED' as never },
    });
    return (records as unknown as IntegrationRow[]).map((record) =>
      this.toEntity(record),
    );
  }
}
