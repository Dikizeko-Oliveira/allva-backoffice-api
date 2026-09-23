import { Injectable } from '@nestjs/common';
import { MembershipFreezeService } from 'src/modules/organizations/application/services/membership-freeze.service';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import {
  AdAccountFreezeService,
  type FreezePreview,
} from 'src/modules/integrations/application/services/ad-account-freeze.service';
import { DowngradeContextResolver } from 'src/modules/integrations/application/services/downgrade-context.resolver';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';

/**
 * A superfície HTTP do congelamento: mostrar a consequência e receber a escolha.
 *
 * O serviço embaixo não conhece assinatura nem conta de usuário — ele recebe
 * organização e plano de destino. Resolver *qual* é o plano de destino é
 * trabalho de aplicação, e é o que este caso de uso faz.
 */
@Injectable()
export class AdAccountFreezeUseCase {
  constructor(
    private readonly freeze: AdAccountFreezeService,
    private readonly scope: OwnerScopeResolverService,
    private readonly organizationPlan: OrganizationPlanPortInterface,
    private readonly seats: MembershipFreezeService,
    private readonly context: DowngradeContextResolver,
  ) {}

  async previewForAccount(accountId: string): Promise<FreezePreview> {
    const context = await this.context.resolve(accountId);

    return this.freeze.preview({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
    });
  }

  async chooseForAccount(
    accountId: string,
    keepActiveAdAccountIds: string[],
  ): Promise<FreezePreview> {
    const context = await this.context.requireScheduled(accountId);

    const preview = await this.freeze.preview({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
    });

    this.freeze.assertSelectionIsValid(preview, keepActiveAdAccountIds);

    return this.freeze.apply({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
      keepActiveAdAccountIds,
    });
  }

  /**
   * Agenda o congelamento na queda de plano — chamado por `billing`.
   *
   * Sem organização não há contas a congelar (assinatura de escopo pessoal,
   * anterior ao multi-tenant), e falhar aqui derrubaria a troca de plano por
   * causa de algo que não existe para esse cliente.
   */
  async scheduleForAccount(
    accountId: string,
    targetPlan: { id: string; type: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE' },
    effectiveAt: Date,
  ): Promise<void> {
    const owner = await this.scope.resolveForAccount(accountId);
    if (!owner.organizationId) return;

    /**
     * **O plano da organização é o que faz o downgrade existir.**
     *
     * As nove guardas leem `findPlanTypeByOrganizationId`, e nada o atualizava:
     * a queda mexia só na assinatura de conta. Congelar contas sem isto
     * resolveria uma das nove e deixaria oito entregando o plano caro.
     */
    await this.organizationPlan.scheduleDowngrade({
      organizationId: owner.organizationId,
      planId: targetPlan.id,
      effectiveAt,
    });

    await this.freeze.apply({
      organizationId: owner.organizationId,
      targetPlanType: targetPlan.type,
      effectiveAt,
    });

    // Assentos encolhem junto: dez pessoas ativas num plano de três é o mesmo
    // custo sem receita que dez contas de anúncios num plano de duas.
    await this.seats.apply({
      organizationId: owner.organizationId,
      targetPlanType: targetPlan.type,
      effectiveAt,
    });
  }

  /** Sobe o plano da organização **na hora** e desfaz o congelamento. */
  async upgradeForAccount(
    accountId: string,
    targetPlanId: string,
  ): Promise<void> {
    const owner = await this.scope.resolveForAccount(accountId);
    if (!owner.organizationId) return;

    await this.organizationPlan.applyUpgrade({
      organizationId: owner.organizationId,
      planId: targetPlanId,
    });

    await this.freeze.thawAll(owner.organizationId);
    await this.seats.thawAll(owner.organizationId);
  }
}
