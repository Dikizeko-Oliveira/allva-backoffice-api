import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import { OrganizationLimitService } from 'src/modules/organizations/application/services/organization-limit.service';
import {
  CreateOrganizationInputDto,
  CreateOrganizationOutputDto,
} from '../dtos';
import {
  Organization,
  OrganizationSubscription,
  OrganizationUser,
} from 'src/modules/organizations/domain/entities';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import type { PlanType } from 'src/modules/plans/domain/plan-catalog';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';

@Injectable()
export class CreateOrganizationUseCase {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
    private readonly limits: OrganizationLimitService,
    private readonly plans: PlansRepositoryInterface,
  ) {}

  async execute(
    input: CreateOrganizationInputDto,
    ownerId: string,
  ): Promise<CreateOrganizationOutputDto> {
    const account = await this.accountsRepository.findById(ownerId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    /**
     * Quantas organizações a conta pode possuir é decisão de **plano**, não do
     * schema.
     *
     * Antes a segunda era recusada com `ORGANIZATION_ALREADY_EXISTS`, em
     * qualquer plano — inclusive no Enterprise, cujo ICP declarado (holding,
     * rede de franquias, agência que separa carteiras) existe justamente para
     * ter várias. A recusa agora nomeia o plano e para onde ir, como toda outra
     * recusa por teto.
     *
     * O cálculo mora em `OrganizationLimitService` porque a tela também precisa
     * dele: `GET /organizations/creation-allowance` chama este mesmo método
     * para decidir se mostra o botão de criar. Enquanto a regra era inline aqui,
     * a única forma de perguntar era tentar — e o usuário só descobria a recusa
     * depois de preencher o formulário.
     */
    const allowance = await this.limits.resolveForAccount(ownerId);

    if (!allowance.state.allowed) throw planLimitRefusal(allowance.state);

    const referencePlanType: PlanType | null = allowance.referencePlanType;

    const organization = Organization.create({
      ownerId,
      name: input.name,
      // Digitado no formulário: já é a declaração de um humano, e a tela de
      // convite não tem o que perguntar depois.
      nameConfirmed: true,
      cnpj: input.cnpj,
      phone: input.phone,
      address: input.address,
      addressNumber: input.addressNumber,
      addressComplement: input.addressComplement,
      addressCity: input.addressCity,
    });

    // The creator becomes an ACTIVE OWNER member so RBAC and the multi-tenant
    // context resolver treat ownership uniformly with every other membership.
    const ownerMembership = OrganizationUser.create({
      organizationId: organization.id,
      accountId: ownerId,
      role: 'OWNER',
      status: 'ACTIVE',
    });

    /**
     * Uma escrita, não três.
     *
     * Eram `save(organization)`, `save(ownerMembership)` e o audit, soltas: uma
     * falha entre a primeira e a segunda deixava organização sem participação
     * OWNER, e o dono sem permissão na própria organização — o `membershipId:
     * null` que `CurrentOrganizationResolver` documenta ter encontrado em dado
     * legado. O repositório passou a receber as duas porque a fronteira da
     * transação é dele, não daqui.
     */
    await this.organizationsRepository.saveWithOwner(
      organization,
      ownerMembership,
      await this.resolveSubscription(organization.id, referencePlanType),
    );

    await this.auditLog.record({
      event: 'organization.created',
      entityType: 'organization',
      entityId: organization.id,
      actorId: ownerId,
      organizationId: organization.id,
      metadata: { name: organization.name },
    });

    /**
     * `owner.created` faltava só neste caminho.
     *
     * O provisionamento de lead sempre o registrou, e o do cadastro nasceu
     * registrando. Aqui não — então a criação de organização pelo produto era a
     * única que não deixava rastro de quem virou dono. É o caminho do Enterprise
     * multi-organização, que é justamente onde a trilha importa mais.
     */
    await this.auditLog.record({
      event: 'owner.created',
      entityType: 'organization_user',
      entityId: ownerMembership.id,
      actorId: ownerId,
      organizationId: organization.id,
      metadata: { name: organization.name, role: 'OWNER' },
    });

    return { id: organization.id };
  }

  /**
   * Com que plano a nova organização nasce.
   *
   * **Herda o da organização de referência**, quando existe. Só o Enterprise
   * chega aqui com uma segunda — a cota `organizations` é 1 nos demais —, e um
   * teste de 14 dias bloquearia no dia 15 a segunda carteira de um cliente que
   * está pagando por ela. `ACTIVE` sem `trialEndsAt`, porque o estado de
   * cobrança mora na assinatura de conta: a linha da organização carrega o
   * portão de plano, e o portão é o mesmo contrato.
   *
   * Sem referência é a primeira organização da conta, e ela nasce no teste — a
   * mesma regra do cadastro, para as duas portas de entrada não divergirem.
   */
  private async resolveSubscription(
    organizationId: string,
    referencePlanType: PlanType | null,
  ): Promise<OrganizationSubscription> {
    if (referencePlanType && referencePlanType !== 'FREE') {
      const inherited = await this.plans.findByType(referencePlanType);

      if (inherited) {
        return OrganizationSubscription.onPlan({
          organizationId,
          planId: inherited.id,
        });
      }
    }

    const free = await this.plans.findByType('FREE');

    if (!free) {
      throw new NotFoundException({
        code: 'PLAN_NOT_CONFIGURED',
        message: 'No FREE plan is configured to start the organization trial',
      });
    }

    return OrganizationSubscription.startTrial({
      organizationId,
      planId: free.id,
      trialDays: free.trialDays,
    });
  }
}
