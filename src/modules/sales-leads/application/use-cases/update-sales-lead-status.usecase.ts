import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  UpdateSalesLeadStatusInputDto,
  UpdateSalesLeadStatusOutputDto,
} from '../dtos';
import { SalesLeadsRepositoryInterface } from '../../domain/ports';
import { SalesLeadStatus } from '../../domain/entities';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';

@Injectable()
export class UpdateSalesLeadStatusUseCase {
  constructor(
    private readonly salesLeadsRepository: SalesLeadsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  /**
   * Mover um lead é decisão comercial — e `CLOSED_WON` **provisiona uma
   * organização Enterprise**.
   *
   * Sem esta guarda, qualquer conta autenticada fechava um lead qualquer e saía
   * com uma organização no plano negociado, de graça. A rota pedia sessão e mais
   * nada.
   */
  async execute(
    id: string,
    input: UpdateSalesLeadStatusInputDto,
    actorId: string,
  ): Promise<UpdateSalesLeadStatusOutputDto> {
    await this.platformRole.assertPermission(actorId, 'leads:manage');

    const salesLead = await this.salesLeadsRepository.findById(id);

    if (!salesLead) {
      throw new NotFoundException({
        code: 'SALES_LEAD_NOT_FOUND',
        message: 'Sales lead not found',
      });
    }

    try {
      salesLead.changeStatus(input.status as SalesLeadStatus);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'SALES_LEAD_ALREADY_CLOSED'
      ) {
        throw new ConflictException({
          code: 'SALES_LEAD_ALREADY_CLOSED',
          message: 'Sales lead is already closed and cannot change status',
        });
      }
      throw error;
    }

    /**
     * **Ganhar o negócio não provisiona mais nada.**
     *
     * `CLOSED_WON` criava a organização na hora. Ganhar e ativar são dois atos
     * com a assinatura de um documento entre eles — e um pode acontecer semanas
     * depois do outro, ou nunca: negócio ganho que não fecha contrato existe. O
     * provisionamento passou para `POST /admin/contracts/:id/activate`, que é
     * onde o plano contratado e os tetos negociados de fato existem.
     *
     * Aqui sobrou o que sempre foi: mover o lead no funil.
     */
    await this.salesLeadsRepository.update(salesLead);

    return { id: salesLead.id, status: salesLead.status };
  }
}
