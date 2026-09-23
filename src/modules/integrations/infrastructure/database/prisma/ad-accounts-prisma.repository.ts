import { Injectable } from '@nestjs/common';
import { AdAccount } from 'src/modules/integrations/domain/entities';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * **Sem um único `as never`, e a ausência é o ponto.**
 *
 * A versão anterior gravava nove campos que `ad_accounts` não tem — herança da
 * v1, sobrevivente da migração destrutiva de A2-S1. Os casts silenciavam o
 * compilador e o erro só aparecia em produção, como `Unknown argument`.
 * Tipagem honesta aqui é o que impede a próxima divergência de schema de viver
 * meses sem ser vista.
 */
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
export class AdAccountsPrismaRepository implements AdAccountsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async save(adAccount: AdAccount): Promise<void> {
    await this.prisma.adAccount.create({
      data: {
        id: adAccount.id,
        integrationId: adAccount.integrationId,
        organizationId: adAccount.organizationId,
        accountId: adAccount.accountId,
        platform: adAccount.platform as never,
        externalAccountId: adAccount.externalAccountId,
        name: adAccount.name,
        currency: adAccount.currency,
        timezone: adAccount.timezone,
        discoveredAt: adAccount.discoveredAt,
        frozenAt: adAccount.frozenAt,
      },
    });
  }

  async update(adAccount: AdAccount): Promise<void> {
    await this.prisma.adAccount.update({
      where: { id: adAccount.id },
      data: {
        integrationId: adAccount.integrationId,
        name: adAccount.name,
        currency: adAccount.currency,
        timezone: adAccount.timezone,
        frozenAt: adAccount.frozenAt,
      },
    });
  }

  async findById(id: string): Promise<AdAccount | null> {
    const record = await this.prisma.adAccount.findUnique({ where: { id } });
    return record ? this.toEntity(record as AdAccountRow) : null;
  }

  async findByIntegrationAndExternalId(
    integrationId: string,
    externalAccountId: string,
  ): Promise<AdAccount | null> {
    const record = await this.prisma.adAccount.findFirst({
      where: { integrationId, externalAccountId },
    });
    return record ? this.toEntity(record as AdAccountRow) : null;
  }

  async findByOrganizationPlatformAndExternalId(
    organizationId: string,
    platform: Platform,
    externalAccountId: string,
  ): Promise<AdAccount | null> {
    // `findUnique` sobre a própria constraint: a busca e a guarda de duplicata
    // passam a ser a mesma pergunta, que é o que impedia o P2002 de virar 500.
    const record = await this.prisma.adAccount.findUnique({
      where: {
        organizationId_platform_externalAccountId: {
          organizationId,
          platform: platform as never,
          externalAccountId,
        },
      },
    });
    return record ? this.toEntity(record as AdAccountRow) : null;
  }

  async listByIntegrationId(integrationId: string): Promise<AdAccount[]> {
    const records = await this.prisma.adAccount.findMany({
      where: { integrationId },
    });
    return records.map((row) => this.toEntity(row as AdAccountRow));
  }

  /**
   * Contas **ativas** da organização — o uso contra o qual o teto do plano
   * incide.
   *
   * Ativa é vinculada e não congelada. `frozenAt` no futuro ainda não vale:
   * um downgrade agendado não pode liberar vaga antes da data, senão o cliente
   * agendaria a queda de plano só para conectar mais uma conta hoje.
   */
  async countActiveByOrganizationId(organizationId: string): Promise<number> {
    return this.prisma.adAccount.count({
      where: {
        organizationId,
        integrationId: { not: null },
        OR: [{ frozenAt: null }, { frozenAt: { gt: new Date() } }],
      },
    });
  }

  async listActiveByIntegrationId(integrationId: string): Promise<AdAccount[]> {
    const records = await this.prisma.adAccount.findMany({
      where: {
        integrationId,
        OR: [{ frozenAt: null }, { frozenAt: { gt: new Date() } }],
      },
    });
    return records.map((row) => this.toEntity(row as AdAccountRow));
  }

  /**
   * Desconectar a integração **desvincula** as contas em vez de "desativá-las".
   *
   * É a semântica que a v2 já tinha em `detachIntegration`: a credencial sai, a
   * identidade e todo o histórico ficam (P10). `listSyncable` já ignora conta
   * sem integração, então a desconexão passa a de fato parar o sync — o que a
   * versão anterior não fazia, porque escrevia numa coluna inexistente.
   */
  async markIntegrationAccountsDisconnected(
    integrationId: string,
  ): Promise<void> {
    await this.prisma.adAccount.updateMany({
      where: { integrationId },
      data: { integrationId: null },
    });
  }

  /**
   * Saúde de sync por conta — colunas de verdade, ao contrário do que esta
   * classe lia antes.
   */
  async listSyncHealthByIntegrationId(integrationId: string) {
    const rows = await this.prisma.adAccount.findMany({
      where: { integrationId },
      select: {
        id: true,
        syncHealth: true,
        syncHealthReason: true,
        unreachableSince: true,
        lastSuccessfulFullSyncAt: true,
      },
    });

    return rows.map((row) => ({
      adAccountId: row.id,
      syncHealth: row.syncHealth,
      syncHealthReason: row.syncHealthReason,
      unreachableSince: row.unreachableSince,
      lastSuccessfulFullSyncAt: row.lastSuccessfulFullSyncAt,
    }));
  }

  private toEntity(row: AdAccountRow): AdAccount {
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
}
