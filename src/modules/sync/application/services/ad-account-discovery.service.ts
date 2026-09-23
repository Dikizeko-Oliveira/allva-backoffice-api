import { Injectable, Logger } from '@nestjs/common';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';

export type DiscoveryOutcome = {
  integrationId: string;
  discovered: number;
  rebound: number;
  seen: number;
};

/**
 * Descoberta de contas — `ad-account-discovery`, diário por integração (§8.8).
 *
 * Uma conta de anúncios criada depois da conexão nunca entraria no domínio sem
 * este job: o ingest percorre as contas que já conhece, e a listagem só
 * acontecia no fluxo de onboarding. O usuário criaria a conta na plataforma e
 * ela simplesmente não apareceria na Allva, sem erro nenhum a investigar.
 *
 * O upsert casa por `(organizationId, platform, externalAccountId)` (P10), então
 * a descoberta e o rebind usam o mesmo caminho — e uma conta reconectada por
 * outra credencial é **religada**, nunca duplicada.
 */
@Injectable()
export class AdAccountDiscoveryService {
  private readonly logger = new Logger(AdAccountDiscoveryService.name);

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly events: DomainEventBus,
  ) {}

  async execute(input: {
    integrationId: string;
    ctx: JobContext;
  }): Promise<DiscoveryOutcome> {
    const integration = await this.integrations.findById(input.integrationId);

    if (!integration?.organizationId) {
      // Credencial sem organização não é migrável nem descobrível: A2-S1 já
      // apertou a coluna para NOT NULL, então isto só acontece se a linha
      // sumir entre o agendamento e a execução.
      return {
        integrationId: input.integrationId,
        discovered: 0,
        rebound: 0,
        seen: 0,
      };
    }

    const platform = integration.providerType as Platform;
    const provider = this.providers.for(platform);
    const emit = {
      ...input.ctx,
      organizationId: integration.organizationId,
    };

    const external = await provider.listAdAccounts(integration);
    const outcome: DiscoveryOutcome = {
      integrationId: integration.id,
      discovered: 0,
      rebound: 0,
      seen: external.length,
    };

    for (const account of external) {
      // Descobrir não é religar: conta desvinculada continua desvinculada.
      // Religar é de quem vincula de novo e do rebind.
      const upserted = await this.accounts.upsertDiscovered(
        {
          organizationId: integration.organizationId,
          accountId: integration.accountId,
          platform,
          externalAccountId: account.externalAccountId,
          name: account.name,
          currency: account.currency,
          timezone: account.timezone,
          integrationId: integration.id,
        },
        { relinkDetached: false },
      );

      if (upserted.created) {
        outcome.discovered += 1;
        this.events.emitFrom(emit, 'ad_account.discovered', {
          adAccountId: upserted.id,
          platform,
        });
      } else if (upserted.rebound) {
        outcome.rebound += 1;
      }
    }

    if (outcome.discovered > 0) {
      this.logger.log(
        `ad_account.discovered integrationId=${integration.id} novas=${outcome.discovered}`,
      );
    }

    return outcome;
  }
}
