import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import {
  OrganizationInvitationsRepositoryInterface,
  OrganizationPlanPortInterface,
  OrganizationQuotaPortInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { resolveSeatLimit } from 'src/modules/organizations/domain/plan-seat-limits';

/**
 * Quantos assentos a organização ocupa, e de quantos ela dispõe.
 *
 * `limit` nulo é **plano irresolúvel**, não ilimitado — o Enterprise passou a
 * nomear um piso, e ilimitado deixou de existir.
 */
export type SeatUsage = {
  limit: number | null;
  /** Assentos ocupados: `activeMembers + pendingInvitations`. */
  used: number;
  activeMembers: number;
  pendingInvitations: number;
};

/**
 * Enforces the per-organization seat limit derived from its plan. A seat is an
 * ACTIVE membership (owner included) or a still-pending invitation, so an org
 * cannot outrun its plan by stacking pending invites.
 *
 * A mesma contagem alimenta a tela: `GET /organizations` devolve `seats`, e é o
 * que a seção de membros mostra ("2 de 10 usuários do plano"). Recontar do lado
 * de lá seria contar diferente — a lista de membros não sabe que um convite
 * pendente ocupa assento, e o número exibido divergiria do número que recusa o
 * próximo convite.
 */
@Injectable()
export class SeatLimitService {
  private readonly logger = new Logger(SeatLimitService.name);

  constructor(
    private readonly organizationUsersRepository: OrganizationUsersRepositoryInterface,
    private readonly invitationsRepository: OrganizationInvitationsRepositoryInterface,
    private readonly organizationPlan: OrganizationPlanPortInterface,
    private readonly quotas: OrganizationQuotaPortInterface,
  ) {}

  async assertCanInvite(organizationId: string): Promise<void> {
    const limit = await this.resolveLimit(organizationId);

    // Sem plano resolvível não há o que aplicar, e nem se conta: recusar um
    // convite legítimo por não saber o plano é atrito que o cliente relata em
    // minutos. Não é mais o caso do Enterprise, que passou a nomear um piso.
    if (limit === null) return;

    const { used } = await this.countSeats(organizationId);

    if (used >= limit) {
      this.logger.warn(
        `seat_limit.reached organizationId=${organizationId} used=${used} limit=${limit}`,
      );
      throw new ForbiddenException({
        code: 'SEAT_LIMIT_REACHED',
        message: `Organization plan seat limit reached (${used}/${limit}). Upgrade the plan to invite more members.`,
      });
    }
  }

  /**
   * O mesmo cálculo de `assertCanInvite`, para quem só quer **mostrar**.
   *
   * Conta mesmo sem plano resolvível — ao contrário da guarda, que abre na
   * dúvida e nem conta: aqui não há nada a recusar, e a tela ainda tem um número
   * verdadeiro a exibir ao lado da lista.
   */
  async resolve(organizationId: string): Promise<SeatUsage> {
    const [limit, seats] = await Promise.all([
      this.resolveLimit(organizationId),
      this.countSeats(organizationId),
    ]);

    return { limit, ...seats };
  }

  /**
   * O teto negociado vence o do plano — é o mesmo contrato que governa contas
   * de anúncios e anúncios analisados.
   */
  private async resolveLimit(organizationId: string): Promise<number | null> {
    const [planType, overrides] = await Promise.all([
      this.organizationPlan.findPlanTypeByOrganizationId(organizationId),
      this.quotas.findOverrides(organizationId),
    ]);

    return overrides.seats ?? resolveSeatLimit(planType);
  }

  /** Um assento é uma participação ACTIVE (dono incluído) ou um convite pendente. */
  private async countSeats(
    organizationId: string,
  ): Promise<Omit<SeatUsage, 'limit'>> {
    const [members, invitations] = await Promise.all([
      this.organizationUsersRepository.listByOrganizationId(organizationId),
      this.invitationsRepository.listByOrganizationId(organizationId),
    ]);

    const activeMembers = members.filter((member) => member.isActive()).length;
    const pendingInvitations = invitations.filter((invitation) =>
      invitation.isPending(),
    ).length;

    return {
      used: activeMembers + pendingInvitations,
      activeMembers,
      pendingInvitations,
    };
  }
}
