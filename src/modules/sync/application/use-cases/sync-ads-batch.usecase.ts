import { Injectable } from '@nestjs/common';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { SyncDispatcher } from 'src/modules/sync/infrastructure/queues/sync.dispatcher';

/** Lote máximo de `POST /ads/sync-batch`. Acima disso a chamada deixa de caber
 *  numa requisição de insights e o refresh vira um ingest disfarçado. */
export const SYNC_BATCH_MAX_ADS = 100;

/**
 * ② Refresh dirigido, pedido pela interface (§8.3).
 *
 * Responde `202` e enfileira: a leitura da plataforma leva segundos e prender a
 * requisição HTTP nela faria a tela travar esperando terceiros. O contrato é o
 * mesmo de §7.0.3 para escrita — aceito, em andamento —, e não "pronto".
 */
@Injectable()
export class SyncAdsBatchUseCase {
  constructor(
    private readonly dispatcher: SyncDispatcher,
    private readonly requestContext: RequestContextService,
  ) {}

  async execute(input: {
    organizationId: string;
    adIds: string[];
  }): Promise<{ accepted: number }> {
    const adIds = [...new Set(input.adIds)];

    if (adIds.length === 0) {
      throw new DomainError({
        code: 'SYNC_BATCH_EMPTY',
        category: 'VALIDATION',
        message: 'Informe ao menos um anúncio para atualizar.',
      });
    }

    if (adIds.length > SYNC_BATCH_MAX_ADS) {
      throw new DomainError({
        code: 'SYNC_BATCH_TOO_LARGE',
        category: 'VALIDATION',
        message: `O lote máximo é de ${SYNC_BATCH_MAX_ADS} anúncios.`,
        details: { requested: adIds.length, max: SYNC_BATCH_MAX_ADS },
        remediation: 'Divida o pedido em lotes menores.',
      });
    }

    // A correlação vem da requisição quando existe: é ela que liga "o usuário
    // clicou em atualizar" a tudo que o worker fizer depois (§5.6.2).
    const ctx = createRootJobContext(
      this.requestContext.getCorrelationId() ?? undefined,
    );

    await this.dispatcher.refresh({
      ctx,
      organizationId: input.organizationId,
      adIds,
    });

    return { accepted: adIds.length };
  }
}
