import { Injectable } from '@nestjs/common';
import { AdAccount } from 'src/modules/integrations/domain/entities';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { AuditLogService } from 'src/modules/audit/application';
import { isUniqueViolation } from 'src/shared/infrastructure/database/prisma/prisma-errors';

export type LinkTarget = {
  integrationId: string;
  organizationId: string;
  accountId: string;
  platform: Platform;
  externalAccountId: string;
  name: string;
  currency: string;
  timezone: string;
};

/**
 * Vincular uma conta de anúncios à credencial corrente, **idempotentemente**.
 *
 * Mora fora do use case porque a idempotência aqui não é detalhe de uma rota: a
 * mesma conta chega por vinculação manual, por religamento de credencial e pela
 * descoberta diária, e as três precisam concordar sobre o que significa "esta
 * conta já existe".
 *
 * A identidade é `(organizationId, platform, externalAccountId)` — a chave que o
 * banco garante. Nunca a credencial: ela é atributo corrente da conta (P10), e
 * desconectar a zera. Foi essa confusão que fazia o fluxo de desconectar e
 * reconectar terminar em 500.
 */
@Injectable()
export class AdAccountLinkerService {
  constructor(
    private readonly adAccounts: AdAccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async link(target: LinkTarget): Promise<{ id: string; relinked: boolean }> {
    const existing = await this.find(target);
    if (existing) return this.relink(existing, target);

    const adAccount = AdAccount.create({
      integrationId: target.integrationId,
      organizationId: target.organizationId,
      accountId: target.accountId,
      platform: target.platform,
      externalAccountId: target.externalAccountId,
      name: target.name,
      currency: target.currency,
      timezone: target.timezone,
    });

    try {
      await this.adAccounts.save(adAccount);
    } catch (error) {
      // Dois cliques simultâneos passam os dois pela busca acima. O vencedor
      // grava; o perdedor relê e revincula.
      if (!isUniqueViolation(error)) throw error;

      const raced = await this.find(target);
      if (!raced) throw error;

      return this.relink(raced, target);
    }

    await this.record(adAccount.id, target, false);
    return { id: adAccount.id, relinked: false };
  }

  private find(target: LinkTarget): Promise<AdAccount | null> {
    return this.adAccounts.findByOrganizationPlatformAndExternalId(
      target.organizationId,
      target.platform,
      target.externalAccountId,
    );
  }

  private async relink(
    existing: AdAccount,
    target: LinkTarget,
  ): Promise<{ id: string; relinked: boolean }> {
    existing.attachIntegration(target.integrationId);
    existing.unfreeze();
    await this.adAccounts.update(existing);

    await this.record(existing.id, target, true);
    return { id: existing.id, relinked: true };
  }

  /**
   * Auditoria nos **dois** caminhos.
   *
   * Antes só a criação registrava, então religar uma conta — o caso mais
   * frequente depois do primeiro dia — não deixava rastro de quem fez o quê.
   */
  private record(
    adAccountId: string,
    target: LinkTarget,
    relinked: boolean,
  ): Promise<void> {
    return this.auditLog.record({
      event: 'ad_account.linked',
      entityType: 'ad_account',
      entityId: adAccountId,
      actorId: target.accountId,
      organizationId: target.organizationId,
      metadata: {
        platform: target.platform,
        externalAccountId: target.externalAccountId,
        integrationId: target.integrationId,
        relinked,
      },
    });
  }
}
