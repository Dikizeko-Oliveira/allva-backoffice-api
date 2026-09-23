import { Injectable } from '@nestjs/common';
import { SupportTicketsRepositoryInterface } from 'src/modules/support/domain/ports';
import { SupportCenterAccessService } from '../services/support-center-access.service';
import { SupportTicketsSummaryOutputDto } from '../dtos';

/**
 * A janela dos "resolvidos recentemente".
 *
 * Trinta dias porque é o período que a tela rotula, e o rótulo vem daqui
 * (`windowDays`) em vez de estar escrito no componente — assim o número na
 * legenda nunca discorda do número contado.
 */
const RESOLUTION_WINDOW_DAYS = 30;

/**
 * `GET /api/v1/support/tickets/summary` — os cartões do topo da Central.
 *
 * Endpoint próprio, e não campos extras na listagem: os indicadores somam a
 * organização inteira, e a listagem responde a um filtro. Enfiar os dois na
 * mesma resposta faria os cartões mudarem ao trocar de aba.
 *
 * **Não há "tempo médio de primeira resposta"**, embora o desenho original da
 * tela o pedisse: nada carimba a primeira resposta hoje. Publicar o número a
 * partir de `updatedAt` seria chamar de "resposta" a mudança de status, que é
 * outra coisa. O cartão mede o que existe — tempo até a resolução.
 */
@Injectable()
export class GetSupportTicketsSummaryUseCase {
  constructor(
    private readonly ticketsRepository: SupportTicketsRepositoryInterface,
    private readonly access: SupportCenterAccessService,
  ) {}

  async execute(input: {
    organizationId: string | null;
  }): Promise<SupportTicketsSummaryOutputDto> {
    const organizationId = await this.access.assert(
      input.organizationId,
      'support-dedicated-channel',
    );

    const resolvedSince = new Date(
      Date.now() - RESOLUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    const summary = await this.ticketsRepository.summarize({
      organizationId,
      resolvedSince,
    });

    return { ...summary, windowDays: RESOLUTION_WINDOW_DAYS };
  }
}
