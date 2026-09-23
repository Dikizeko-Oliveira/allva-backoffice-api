import { Injectable, NotFoundException } from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { WasteItemsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-items.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { ResolveAdWasteDto } from 'src/modules/waste/application/dtos/resolve-waste-item.dto';

/**
 * `POST /ads/{id}/resolve` — a linha "por anúncio" de §10.9.
 *
 * Fecha os achados abertos de um anúncio de uma vez, opcionalmente restrita a
 * `types`. É a rota que existe porque a unidade da ação humana raramente é o
 * achado: quem trocou o criativo resolveu a fadiga daquele anúncio, e obrigá-lo
 * a abrir três itens para dizer isso três vezes é como o produto ensina que
 * resolver não vale o esforço — e a base de resolução manual, que é insumo de
 * P8, nasce vazia por atrito.
 *
 * **A denormalização é recalculada na hora.** Sem isso, o anúncio ficaria com o
 * `openWasteCount` antigo até o ciclo da madrugada: um dia inteiro exibindo
 * dinheiro queimando num anúncio que o usuário acabou de limpar. O job de
 * reconciliação (C3) continua sendo a rede, não o caminho.
 */
@Injectable()
export class ResolveAdWasteUseCase {
  constructor(
    private readonly items: WasteItemsRepositoryInterface,
    private readonly read: WasteReadRepositoryInterface,
    private readonly events: DomainEventBus,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    adId: string;
    body: ResolveAdWasteDto;
  }) {
    if (!this.env.get('WASTE_DETECTOR_V2_ENABLED')) {
      throw new DomainError({
        code: 'WASTE_DETECTOR_DISABLED',
        category: 'PRECONDITION_FAILED',
        message: 'O detector de desperdício está desligado nesta instalação.',
        remediation: 'Ligue WASTE_DETECTOR_V2_ENABLED para habilitar /waste.',
      });
    }

    const now = new Date();

    const resolved = await this.items.resolveForAd({
      adId: input.adId,
      organizationId: input.organizationId,
      types: input.body.types,
      kind: input.body.kind,
      reason: input.body.reason,
      resolvedByAccountId: input.accountId,
      now,
    });

    if (resolved.length === 0) {
      // Nenhum aberto que casasse: pode ser anúncio de outra organização,
      // anúncio inexistente ou anúncio já limpo. Os três respondem igual —
      // distinguir "não é seu" de "não existe" entregaria a existência de dados
      // de outro tenant.
      throw new NotFoundException(
        'Nenhum achado aberto para resolver neste anúncio.',
      );
    }

    // O `max` de §10.6 recalculado a partir da view, e **antes** de reler: a
    // resposta tem de mostrar o estado depois da ação, não o de antes dela.
    await this.items.recomputeDenormalization([input.adId], now);

    const emit = {
      ...createRootJobContext(),
      organizationId: input.organizationId,
    };

    // Um evento **por item**, não um por chamada: `alerts`, `audit` e a medição
    // de P8 contam achados resolvidos, e um evento agregado obrigaria cada
    // consumidor a desempacotar uma lista para chegar ao mesmo número.
    for (const item of resolved) {
      this.events.emitFrom(emit, 'waste.resolved', {
        adId: input.adId,
        wasteItemId: item.id,
        resolutionKind: input.body.kind,
      });
    }

    const remaining = await this.read.openForAd(
      input.organizationId,
      input.adId,
    );

    return envelope(
      {
        adId: input.adId,
        resolved: resolved.map((item) => ({ id: item.id, type: item.type })),
        resolutionKind: input.body.kind,
        remainingOpen: remaining.length,
      },
      {
        asOf: now.toISOString(),
        provenance: {
          windowDays: remaining.at(0)?.windowDays ?? 0,
          detectorProfileVersion: remaining.at(0)?.detectorProfileVersion,
        },
      },
    );
  }
}
