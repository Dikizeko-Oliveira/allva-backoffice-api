import { Injectable, Logger } from '@nestjs/common';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';

export type RebindOutcome = {
  previousIntegrationIds: string[];
  integrationId: string;
  reboundAdAccountIds: string[];
  createdAdAccountIds: string[];
  /** Contas que a credencial nova não alcança. **Nada é arquivado.** */
  unreachableAdAccountIds: string[];
};

/**
 * ⑤ REBIND — reconexão preservando identidade (§8.6, P10).
 *
 * ```text
 * 1. lista contas acessíveis pela nova credencial
 * 2. casa por (organizationId, platform, externalAccountId) — NUNCA por integrationId
 * 3. conta conhecida       → adAccount.integrationId = nova; preserva todo o histórico
 *    conta nova            → cria AdAccount; ingest inicial
 *    conta inacessível     → UNREACHABLE + alerta
 *                            NÃO arquiva ads · NÃO resolve waste · NÃO expira recomendações
 * 4. credencial antiga revogada; a linha de Integration é preservada para auditoria
 * 5. audit: integration.rebound
 * ```
 *
 * **Perder acesso a uma conta é evento de visibilidade, não de mídia.** Os
 * anúncios continuam existindo e gastando. Um rebind que arquivasse o que a
 * credencial nova não alcança destruiria exatamente o histórico que P10 existe
 * para preservar — e o usuário veria seu desperdício "resolver" no dia em que
 * trocou de token.
 */
@Injectable()
export class RebindIntegrationService {
  private readonly logger = new Logger(RebindIntegrationService.name);

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly audit: AuditLogService,
    private readonly events: DomainEventBus,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    platform: Platform;
    /** A credencial recém-conectada. */
    integrationId: string;
    ctx: JobContext;
    actorId: string;
  }): Promise<RebindOutcome> {
    const integration = await this.integrations.findById(input.integrationId);

    if (!integration || integration.organizationId !== input.organizationId) {
      throw new DomainError({
        code: 'INTEGRATION_NOT_FOUND',
        category: 'VALIDATION',
        message: 'A integração informada não pertence a esta organização.',
      });
    }

    const provider = this.providers.for(input.platform);

    // 1. o que a credencial nova alcança.
    let accessible: Awaited<ReturnType<typeof provider.listAdAccounts>>;
    try {
      accessible = await provider.listAdAccounts(integration);
    } catch (error) {
      // Falha aqui **não** pode virar "nenhuma conta acessível": seria arquivar
      // por indisponibilidade momentânea. Erro tipado, e nada muda no domínio.
      throw new DomainError({
        code: 'REBIND_LISTING_FAILED',
        category: 'INTEGRATION_UNREACHABLE',
        message:
          'Não foi possível listar as contas de anúncios com a nova credencial.',
        details: { cause: (error as Error).message },
        remediation: 'Tente novamente em alguns minutos.',
      });
    }

    // Inclusive as presas a credencial vencida: reconectar é justamente o caso
    // mais comum de token vencido, e sem elas o rebind não declararia quem a
    // credencial nova não alcança nem revogaria a antiga.
    const known = await this.accounts.listSyncable({
      organizationId: input.organizationId,
      credential: 'ANY_LINKED',
    });
    const knownOfPlatform = known.filter(
      (account) => account.platform === input.platform,
    );

    const outcome: RebindOutcome = {
      previousIntegrationIds: [
        ...new Set(
          knownOfPlatform
            .map((account) => account.integrationId)
            .filter(
              (id): id is string => Boolean(id) && id !== input.integrationId,
            ),
        ),
      ],
      integrationId: input.integrationId,
      reboundAdAccountIds: [],
      createdAdAccountIds: [],
      unreachableAdAccountIds: [],
    };

    // 2–3. casa por identidade de domínio, nunca por credencial.
    for (const external of accessible) {
      const upserted = await this.accounts.upsertDiscovered({
        organizationId: input.organizationId,
        accountId: input.accountId,
        platform: input.platform,
        externalAccountId: external.externalAccountId,
        name: external.name,
        currency: external.currency,
        timezone: external.timezone,
        integrationId: input.integrationId,
      });

      if (upserted.created) {
        outcome.createdAdAccountIds.push(upserted.id);
        this.events.emitFrom(
          { ...input.ctx, organizationId: input.organizationId },
          'ad_account.discovered',
          { adAccountId: upserted.id, platform: input.platform },
        );
      } else {
        outcome.reboundAdAccountIds.push(upserted.id);
      }
    }

    // 3c. as que a credencial nova não alcança.
    const accessibleExternalIds = new Set(
      accessible.map((account) => account.externalAccountId),
    );

    for (const account of knownOfPlatform) {
      if (accessibleExternalIds.has(account.externalAccountId)) continue;

      outcome.unreachableAdAccountIds.push(account.id);
      await this.accounts.updateHealth(account.id, {
        health: 'UNREACHABLE',
        reason: 'ACCOUNT_NOT_ACCESSIBLE',
        unreachableSince: account.unreachableSince ?? new Date(),
      });
      // Nenhuma chamada a arquivamento, a resolução de waste ou a expiração de
      // recomendação. A ausência é a entrega: §8.6 lista as três explicitamente.
    }

    // 4. a credencial antiga é revogada; a linha sobrevive para auditoria.
    for (const previousId of outcome.previousIntegrationIds) {
      await this.revokePrevious(previousId, input.platform);
    }

    this.events.emitFrom(
      { ...input.ctx, organizationId: input.organizationId },
      'integration.rebound',
      {
        previousIntegrationId: outcome.previousIntegrationIds[0] ?? '',
        integrationId: input.integrationId,
        reboundAdAccountIds: outcome.reboundAdAccountIds,
        unreachableAdAccountIds: outcome.unreachableAdAccountIds,
      },
    );

    // 5. auditoria.
    await this.audit.record({
      event: 'integration.rebound',
      entityType: 'integration',
      entityId: input.integrationId,
      actorId: input.actorId,
      organizationId: input.organizationId,
      metadata: {
        platform: input.platform,
        rebound: outcome.reboundAdAccountIds.length,
        created: outcome.createdAdAccountIds.length,
        unreachable: outcome.unreachableAdAccountIds.length,
        previousIntegrationIds: outcome.previousIntegrationIds,
      },
    });

    this.logger.log(
      `integration.rebound organizationId=${input.organizationId} platform=${input.platform} ` +
        `religadas=${outcome.reboundAdAccountIds.length} novas=${outcome.createdAdAccountIds.length} ` +
        `inacessíveis=${outcome.unreachableAdAccountIds.length}`,
    );

    return outcome;
  }

  /**
   * Revoga a credencial antiga sem apagar a linha.
   *
   * Falhar aqui não desfaz o rebind: as contas já apontam para a credencial
   * nova, e o token velho expira sozinho. Reverter por causa de uma revogação
   * que não completou deixaria a organização sem nenhuma credencial válida.
   *
   * **A credencial sai de `CONNECTED` mesmo quando a revogação falha.** Ela foi
   * substituída de qualquer jeito, e as contas que a nova não alcança continuam
   * apontando para ela: mantê-la conectada as deixaria no ingest de hora em
   * hora, lendo com um token que ninguém mais usa.
   */
  private async revokePrevious(
    integrationId: string,
    platform: Platform,
  ): Promise<void> {
    try {
      const previous = await this.integrations.findById(integrationId);
      if (!previous) return;

      try {
        await this.providers.for(platform).revokeToken(previous);
      } catch (error) {
        this.logger.warn(
          `integration.revoke_failed integrationId=${integrationId}: ${(error as Error).message}`,
        );
      }

      previous.markDisconnected();
      await this.integrations.update(previous);
    } catch (error) {
      this.logger.warn(
        `integration.disconnect_failed integrationId=${integrationId}: ${(error as Error).message}`,
      );
    }
  }
}
