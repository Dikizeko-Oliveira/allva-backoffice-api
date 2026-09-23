import { Injectable, NotFoundException } from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import { WasteItemsRepositoryInterface } from 'src/modules/waste/domain/ports/waste-items.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { ResolveWasteItemDto } from 'src/modules/waste/application/dtos/resolve-waste-item.dto';

/**
 * `PATCH /waste/items/{id}/resolve` (§10.9, caminho manual).
 *
 * O usuário só pode declarar dois desfechos: a condição cessou por fora
 * (`RESOLVED_EXTERNALLY`) ou o achado não interessa (`DISMISSED`).
 * `RESOLVED_BY_RESTATEMENT`, `STALE` e `SUPERSEDED_BY_DETECTOR` são conclusões
 * que o worker tira do dado — abri-las à mão permitiria fechar um falso positivo
 * como acerto, e é justamente essa distinção que preserva a honestidade do
 * dataset de P8.
 */
@Injectable()
export class ResolveWasteItemUseCase {
  constructor(
    private readonly items: WasteItemsRepositoryInterface,
    private readonly read: WasteReadRepositoryInterface,
    private readonly events: DomainEventBus,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    organizationId: string;
    accountId: string;
    id: string;
    body: ResolveWasteItemDto;
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

    const resolved = await this.items.resolveOne({
      id: input.id,
      organizationId: input.organizationId,
      kind: input.body.kind,
      reason: input.body.reason,
      resolvedByAccountId: input.accountId,
      now,
    });

    if (!resolved) {
      // O item pode não existir, pertencer a outra organização ou já estar
      // resolvido. Os três respondem igual: distinguir "não é seu" de "não
      // existe" entregaria a existência de dados de outro tenant.
      throw new NotFoundException(
        'Achado não encontrado ou já resolvido nesta organização.',
      );
    }

    this.events.emitFrom(
      { ...createRootJobContext(), organizationId: input.organizationId },
      'waste.resolved',
      {
        adId: resolved.adId,
        wasteItemId: resolved.id,
        resolutionKind: resolved.kind,
      },
    );

    const item = await this.read.findOne(input.organizationId, input.id);

    return envelope(item, {
      asOf: now.toISOString(),
      provenance: {
        windowDays: item?.windowDays ?? 0,
        detectorVersion: item?.detectorVersion,
        detectorProfileVersion: item?.detectorProfileVersion,
      },
    });
  }
}
