import { Injectable } from '@nestjs/common';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import {
  CreateAdminSalesLeadInputDto,
  CreateSalesLeadOutputDto,
} from '../dtos';
import { SalesLead } from '../../domain/entities';
import { SalesLeadsRepositoryInterface } from '../../domain/ports';

/** De onde veio o lead, quando quem o cadastrou foi o operador. */
const BACKOFFICE_SOURCE = 'backoffice';

/**
 * O lead que nasce pela mão do operador, e não pelo formulário de `/sales`.
 *
 * Todo contrato Enterprise parte de um lead — é o que dá ao comercial a
 * rastreabilidade de onde cada negócio veio. Mas nem todo negócio entra pelo
 * site: indicação, evento, uma conversa que começou no LinkedIn. Sem esta
 * porta, esses casos ficariam fora do sistema, ou obrigariam alguém a preencher
 * o formulário público fingindo ser o cliente.
 */
@Injectable()
export class CreateAdminSalesLeadUseCase {
  constructor(
    private readonly salesLeadsRepository: SalesLeadsRepositoryInterface,
    private readonly platformRole: PlatformRoleService,
  ) {}

  async execute(
    input: CreateAdminSalesLeadInputDto,
    actorId: string,
  ): Promise<CreateSalesLeadOutputDto> {
    await this.platformRole.assertPermission(actorId, 'leads:manage');

    const salesLead = SalesLead.create({
      /**
       * **Nulo, e nunca o id do operador.**
       *
       * `accountId` é a conta do *prospect* — preenchida quando alguém já
       * logado preenche o formulário público. Gravar o operador aqui seria uma
       * troca de identidade com consequência concreta: na hora de provisionar,
       * `EnterpriseProvisioningService.resolveOwnerAccount` lê exatamente este
       * campo primeiro, e o operador viraria dono da organização Enterprise do
       * cliente.
       *
       * Quem cadastrou vai em `assignedTo`, que é o campo do vendedor.
       */
      accountId: null,
      assignedTo: actorId,
      companyName: input.companyName,
      workEmail: input.workEmail,
      fullName: input.fullName,
      phone: input.phone,
      estimatedMonthlySpend: input.estimatedMonthlySpend,
      teamSize: input.teamSize,
      platforms: input.platforms,
      notes: input.notes,
      desiredPlan: input.desiredPlan,
      // O canal informado vence; sem ele, fica registrado que veio de dentro.
      // É o que permite ao comercial medir quanto do funil o site traz.
      source: input.source ?? BACKOFFICE_SOURCE,
    });

    await this.salesLeadsRepository.save(salesLead);

    return { id: salesLead.id, status: salesLead.status };
  }
}
