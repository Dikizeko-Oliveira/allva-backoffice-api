import { Injectable } from '@nestjs/common';
import { SyncQuarantineRepositoryInterface } from 'src/modules/sync/domain/ports/sync-quarantine.repository';
import {
  EnvelopedResult,
  envelope,
} from 'src/shared/infrastructure/http/envelope/response-meta';

export type QuarantineItemView = {
  id: string;
  adAccountId: string;
  externalAdId: string;
  reason: string;
  attempts: number;
  firstSeenAt: string;
  lastSeenAt: string;
  payload: Record<string, unknown> | null;
};

/**
 * `GET /sync/quarantine` — o que o domínio **não** conseguiu absorver.
 *
 * A lista existe para ser esvaziada, não contemplada: todo ingest tenta
 * re-resolver o que está aqui antes de processar o que chegou (C6). O que
 * permanece com `attempts` alto é dívida real de integração — uma campanha que
 * a credencial não alcança, um id que a plataforma devolve em dois formatos —, e
 * é isso que a tela precisa mostrar.
 */
@Injectable()
export class ListQuarantineUseCase {
  constructor(private readonly quarantine: SyncQuarantineRepositoryInterface) {}

  async execute(input: {
    organizationId: string;
    adAccountId?: string;
    cursor?: string | null;
    limit?: number;
  }): Promise<EnvelopedResult<QuarantineItemView[]>> {
    const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);

    const { items, nextCursor } = await this.quarantine.list({
      organizationId: input.organizationId,
      adAccountId: input.adAccountId,
      cursor: input.cursor ?? null,
      limit,
    });

    const asOf = items.reduce<Date | null>(
      (latest, item) =>
        !latest || item.lastSeenAt > latest ? item.lastSeenAt : latest,
      null,
    );

    return envelope(
      items.map((item) => ({
        id: item.id,
        adAccountId: item.adAccountId,
        externalAdId: item.externalAdId,
        reason: item.reason,
        attempts: item.attempts,
        firstSeenAt: item.firstSeenAt.toISOString(),
        lastSeenAt: item.lastSeenAt.toISOString(),
        payload: item.payload,
      })),
      {
        // P7: o instante a que o dado se refere é a última vez que **vimos** o
        // item, não o instante da resposta. Sem essa distinção, uma quarentena
        // parada há três dias parece recém-detectada.
        asOf: (asOf ?? new Date()).toISOString(),
        provenance: { engineVersion: 'sync-v2' },
        page: { nextCursor, hasMore: nextCursor !== null },
      },
    );
  }
}
