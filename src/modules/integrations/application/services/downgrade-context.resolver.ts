import { Injectable } from '@nestjs/common';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { OwnerScopeResolverService } from 'src/modules/integrations/application/services/owner-scope-resolver.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type DowngradeContext = {
  organizationId: string;
  targetPlanType: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
  /** Nulo quando não há queda agendada — o alvo é o plano vigente. */
  effectiveAt: Date | null;
};

/**
 * Contra qual plano medir, e a partir de quando.
 *
 * Vive fora dos use cases porque **dois** perguntam a mesma coisa — contas de
 * anúncios e assentos —, e a resposta é idêntica. Duplicá-la faria as duas telas
 * divergirem no primeiro ajuste, mostrando ao usuário dois planos de destino
 * diferentes na mesma queda.
 *
 * **A queda é lida da organização, e não da conta de quem pergunta.**
 *
 * Lia `subscriptions` pela conta autenticada e aplicava o resultado à
 * organização selecionada. Para o dono as duas coincidem — `scheduleForAccount`
 * grava a queda nas duas —, mas para qualquer outro membro elas se separavam:
 * quem tivesse um downgrade agendado na **própria** assinatura escolhia o
 * congelamento de outra organização, medido contra um plano que não era o dela.
 * `organization_subscriptions` é o que as guardas de plano leem, e é contra ele
 * que o congelamento precisa medir.
 */
@Injectable()
export class DowngradeContextResolver {
  constructor(
    private readonly scope: OwnerScopeResolverService,
    private readonly organizationPlan: OrganizationPlanPortInterface,
  ) {}

  /**
   * O plano **agendado**, quando existe, e o vigente quando não.
   *
   * Com o vigente, o preview responde "nada a congelar" em vez de erro — a tela
   * pode chamá-lo sempre, sem antes perguntar se há downgrade.
   */
  async resolve(accountId: string): Promise<DowngradeContext> {
    const owner = await this.scope.resolveForAccount(accountId);

    if (!owner.organizationId) {
      throw new DomainError({
        code: 'ORGANIZATION_REQUIRED',
        category: 'PRECONDITION_FAILED',
        message: 'Esta conta não tem organização.',
      });
    }

    const schedule =
      await this.organizationPlan.findPlanScheduleByOrganizationId(
        owner.organizationId,
      );

    if (!schedule) {
      throw new DomainError({
        code: 'SUBSCRIPTION_NOT_FOUND',
        category: 'PRECONDITION_FAILED',
        message: 'Assinatura não encontrada.',
      });
    }

    const pending =
      schedule.pendingPlanType && schedule.pendingPlanEffectiveAt
        ? {
            type: schedule.pendingPlanType,
            effectiveAt: schedule.pendingPlanEffectiveAt,
          }
        : null;

    const target = pending?.type ?? schedule.planType;

    if (!target) {
      throw new DomainError({
        code: 'PLAN_NOT_FOUND',
        category: 'PRECONDITION_FAILED',
        message: 'Plano da assinatura não encontrado.',
      });
    }

    return {
      organizationId: owner.organizationId,
      targetPlanType: target,
      effectiveAt: pending?.effectiveAt ?? null,
    };
  }

  /** A mesma coisa, exigindo que exista uma queda agendada. */
  async requireScheduled(
    accountId: string,
  ): Promise<DowngradeContext & { effectiveAt: Date }> {
    const context = await this.resolve(accountId);

    if (!context.effectiveAt) {
      throw new DomainError({
        code: 'NO_SCHEDULED_DOWNGRADE',
        category: 'PRECONDITION_FAILED',
        message: 'Não há downgrade agendado para esta assinatura.',
        remediation:
          'A escolha do que fica ativo vale enquanto a queda de plano está agendada.',
      });
    }

    return { ...context, effectiveAt: context.effectiveAt };
  }
}
