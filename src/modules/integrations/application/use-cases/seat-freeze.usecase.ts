import { Injectable } from '@nestjs/common';
import { MembershipFreezeService } from 'src/modules/organizations/application/services/membership-freeze.service';
import { DowngradeContextResolver } from 'src/modules/integrations/application/services/downgrade-context.resolver';

/**
 * A superfície de assentos na queda de plano: mostrar quem perde acesso e
 * receber a escolha.
 *
 * Separado do congelamento de contas de anúncios porque são decisões diferentes
 * com telas diferentes — uma escolhe contas por gasto, a outra escolhe pessoas
 * por cargo — e juntá-las num use case só passava do teto de ~150 linhas que
 * §16.6 impõe, que é onde o caminho de escrita começa a deixar de ser auditável.
 */
@Injectable()
export class SeatFreezeUseCase {
  constructor(
    private readonly seats: MembershipFreezeService,
    private readonly context: DowngradeContextResolver,
  ) {}

  async previewForAccount(accountId: string) {
    const context = await this.context.resolve(accountId);

    return this.seats.preview({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
    });
  }

  async chooseForAccount(accountId: string, keepActiveMembershipIds: string[]) {
    const context = await this.context.requireScheduled(accountId);

    const preview = await this.seats.preview({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
    });

    this.seats.assertSelectionIsValid(preview, keepActiveMembershipIds);

    return this.seats.apply({
      organizationId: context.organizationId,
      targetPlanType: context.targetPlanType,
      effectiveAt: context.effectiveAt,
      keepActiveMembershipIds,
    });
  }
}
