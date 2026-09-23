import { Injectable } from '@nestjs/common';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  EnvelopedResult,
  envelope,
} from 'src/shared/infrastructure/http/envelope/response-meta';
import { RebindIntegrationService } from 'src/modules/sync/application/services/rebind-integration.service';
import { SyncDispatcher } from 'src/modules/sync/infrastructure/queues/sync.dispatcher';

/**
 * `POST /integrations/{platform}/rebind` — ⑤ REBIND (§8.6, P10).
 *
 * Reconectar **não** recria nada. As contas são casadas por
 * `(organizationId, platform, externalAccountId)`, e é essa escolha que faz
 * `ads.id`, `lineage_id` e toda a série sobreviverem à troca de credencial —
 * a identidade do domínio não depende de quem dá acesso a ela.
 */
@Injectable()
export class RebindIntegrationUseCase {
  constructor(
    private readonly rebind: RebindIntegrationService,
    private readonly scope: OwnerScopeResolverService,
    private readonly dispatcher: SyncDispatcher,
    private readonly requestContext: RequestContextService,
  ) {}

  async execute(input: {
    accountId: string;
    platform: Platform;
    integrationId: string;
  }): Promise<EnvelopedResult<RebindResultView>> {
    const owner = await this.scope.resolveForAccount(input.accountId);

    if (!owner.organizationId) {
      throw new DomainError({
        code: 'ORGANIZATION_REQUIRED',
        category: 'NOT_PERMITTED',
        message: 'Selecione uma organização para reconectar a integração.',
      });
    }

    const ctx = createRootJobContext(
      this.requestContext.getCorrelationId() ?? undefined,
    );

    const outcome = await this.rebind.execute({
      organizationId: owner.organizationId,
      accountId: input.accountId,
      platform: input.platform,
      integrationId: input.integrationId,
      ctx,
      actorId: input.accountId,
    });

    // Conta nova entra com ingest inicial completo (§8.6 passo 3). As religadas
    // seguem o ciclo normal: o histórico delas já está no domínio, e forçar um
    // ingest completo aqui gastaria a cota inteira no clique de reconexão.
    for (const adAccountId of outcome.createdAdAccountIds) {
      await this.dispatcher.ingest({
        ctx,
        adAccountId,
        trigger: 'MANUAL',
        forceFullScan: true,
      });
    }

    return envelope(
      {
        integrationId: outcome.integrationId,
        reboundAdAccounts: outcome.reboundAdAccountIds.length,
        newAdAccounts: outcome.createdAdAccountIds.length,
        // Declarado, e não escondido: perder acesso a uma conta é evento de
        // visibilidade. Nada foi arquivado, nenhum desperdício foi resolvido e
        // nenhuma recomendação expirou por causa disto.
        unreachableAdAccounts: outcome.unreachableAdAccountIds,
      },
      {
        asOf: new Date().toISOString(),
        provenance: { engineVersion: 'sync-v2' },
      },
    );
  }
}

export type RebindResultView = {
  integrationId: string;
  reboundAdAccounts: number;
  newAdAccounts: number;
  unreachableAdAccounts: string[];
};
