import { Injectable, Logger } from '@nestjs/common';
import {
  PlanType,
  resolveSeatLimit,
} from 'src/modules/organizations/domain/plan-seat-limits';
import {
  ROLE_RANK,
  type OrganizationRole,
} from 'src/modules/organizations/domain/rbac';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

export type SeatCandidate = {
  membershipId: string;
  accountId: string;
  name: string | null;
  email: string;
  role: OrganizationRole;
  joinedAt: Date;
  /** O dono nunca perde acesso — não é escolha e não entra na conta. */
  protected: boolean;
};

export type SeatFreezePreview = {
  targetPlanType: PlanType;
  effectiveAt: Date | null;
  /** Assentos que o plano de destino permite. `null` é ilimitado. */
  quota: number | null;
  /** Nunca congelam e **ocupam** assento: o dono. */
  protectedSeats: SeatCandidate[];
  /** Entre estes o usuário escolhe quem fica. */
  selectable: SeatCandidate[];
  keeping: string[];
  freezing: string[];
};

/**
 * Quem mantém acesso quando o teto de assentos encolhe.
 *
 * ## Por que existe
 *
 * `SeatLimitService` só recusava **convite novo**. Quem descia do Profissional
 * (10 assentos) para o Individual (3) ficava com dez pessoas ativas para sempre:
 * custo de servir sem receita correspondente, e um caminho óbvio para quem
 * quisesse assinar o plano caro, montar o time e cair de plano mantendo tudo.
 *
 * ## O dono não é uma escolha
 *
 * Congelar o dono deixaria a organização sem ninguém capaz de religá-la — o
 * cliente perderia o acesso à própria conta por ter economizado. Ele fica fora
 * da seleção e **ocupa** um assento, porque ocupa mesmo: um plano de 3 com o
 * dono tem 2 vagas para o resto.
 *
 * ## O default
 *
 * Quem não escolher fica com os papéis mais graduados, e entre iguais os mais
 * antigos. Ao contrário de contas de anúncios — onde gasto é a régua —, gente
 * não tem número: cargo é o proxy honesto de quem decide, e antiguidade desempata
 * sem sorteio.
 */
@Injectable()
export class MembershipFreezeService {
  private readonly logger = new Logger(MembershipFreezeService.name);

  constructor(private readonly prisma: PrismaService) {}

  async preview(input: {
    organizationId: string;
    targetPlanType: PlanType;
    effectiveAt: Date | null;
    keepActiveMembershipIds?: string[];
  }): Promise<SeatFreezePreview> {
    const quota = resolveSeatLimit(input.targetPlanType);
    const candidates = await this.candidatesFor(input.organizationId);

    const protectedSeats = candidates.filter((seat) => seat.protected);
    const selectable = candidates.filter((seat) => !seat.protected);

    const keeping = this.resolveKeeping({
      selectable,
      // O dono já consome assento; o que sobra é o que se pode escolher.
      remaining:
        quota === null ? null : Math.max(0, quota - protectedSeats.length),
      chosen: input.keepActiveMembershipIds,
    });

    const keepingSet = new Set(keeping);

    return {
      targetPlanType: input.targetPlanType,
      effectiveAt: input.effectiveAt,
      quota,
      protectedSeats,
      selectable,
      keeping,
      freezing: selectable
        .filter((seat) => !keepingSet.has(seat.membershipId))
        .map((seat) => seat.membershipId),
    };
  }

  async apply(input: {
    organizationId: string;
    targetPlanType: PlanType;
    effectiveAt: Date;
    keepActiveMembershipIds?: string[];
  }): Promise<SeatFreezePreview> {
    const preview = await this.preview(input);

    await this.prisma.$transaction([
      this.prisma.organizationUser.updateMany({
        where: {
          organizationId: input.organizationId,
          id: { in: preview.freezing },
        },
        data: { frozenAt: input.effectiveAt },
      }),
      // Quem fica não carrega congelamento de uma decisão anterior: a escolha
      // pode mudar quantas vezes for dentro da janela.
      this.prisma.organizationUser.updateMany({
        where: {
          organizationId: input.organizationId,
          id: {
            in: [
              ...preview.keeping,
              ...preview.protectedSeats.map((s) => s.membershipId),
            ],
          },
        },
        data: { frozenAt: null },
      }),
    ]);

    this.logger.log(
      `membership_freeze.scheduled organizacao=${input.organizationId} ` +
        `plano=${input.targetPlanType} mantidos=${preview.keeping.length} ` +
        `congelados=${preview.freezing.length} em=${input.effectiveAt.toISOString()}`,
    );

    return preview;
  }

  /** Subida de plano devolve o acesso a todo mundo que o plano tirou. */
  async thawAll(organizationId: string): Promise<number> {
    const { count } = await this.prisma.organizationUser.updateMany({
      where: { organizationId, frozenAt: { not: null } },
      data: { frozenAt: null },
    });

    if (count > 0) {
      this.logger.log(
        `membership_freeze.thawed organizacao=${organizationId} membros=${count}`,
      );
    }

    return count;
  }

  assertSelectionIsValid(
    preview: SeatFreezePreview,
    keepActiveMembershipIds: string[],
  ): void {
    const selectable = new Set(
      preview.selectable.map((seat) => seat.membershipId),
    );

    const invalid = keepActiveMembershipIds.filter((id) => !selectable.has(id));

    if (invalid.length > 0) {
      throw new DomainError({
        code: 'MEMBERSHIP_NOT_SELECTABLE',
        category: 'PLAN_LIMITED',
        message:
          'Um ou mais membros não entram na seleção: o dono da organização ' +
          'nunca perde acesso e já ocupa um assento.',
        details: { membershipIds: invalid },
      });
    }

    if (preview.quota === null) return;

    const total =
      keepActiveMembershipIds.length + preview.protectedSeats.length;

    if (total > preview.quota) {
      throw new DomainError({
        code: 'MEMBERSHIP_SELECTION_EXCEEDS_QUOTA',
        category: 'PLAN_LIMITED',
        message: `O plano escolhido permite ${preview.quota} assentos, o dono ocupa ${preview.protectedSeats.length}, e foram selecionados ${keepActiveMembershipIds.length}.`,
        details: {
          quota: preview.quota,
          protectedSeats: preview.protectedSeats.length,
          selected: keepActiveMembershipIds.length,
        },
      });
    }
  }

  /**
   * Membros ativos, ordenados por posto e depois por antiguidade.
   *
   * `INVITED` fica de fora: convite pendente não ocupa assento no congelamento —
   * quem o barra é `SeatLimitService`, no aceite. Contá-lo aqui congelaria uma
   * pessoa que já usa o produto para preservar a vaga de alguém que talvez nunca
   * apareça.
   */
  private async candidatesFor(
    organizationId: string,
  ): Promise<SeatCandidate[]> {
    const rows = await this.prisma.organizationUser.findMany({
      where: { organizationId, status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        accountId: true,
        role: true,
        createdAt: true,
        user: { select: { name: true, email: true } },
      },
    });

    return rows
      .map((row) => ({
        membershipId: row.id,
        accountId: row.accountId,
        name: row.user?.name ?? null,
        email: row.user?.email ?? '',
        role: row.role as OrganizationRole,
        joinedAt: row.createdAt,
        protected: row.role === 'OWNER',
      }))
      .sort(
        (a, b) =>
          ROLE_RANK[b.role] - ROLE_RANK[a.role] ||
          a.joinedAt.getTime() - b.joinedAt.getTime(),
      );
  }

  private resolveKeeping(input: {
    selectable: SeatCandidate[];
    remaining: number | null;
    chosen?: string[];
  }): string[] {
    const ranked = input.selectable.map((seat) => seat.membershipId);

    if (input.remaining === null) return ranked;

    if (input.chosen && input.chosen.length > 0) {
      const chosen = new Set(input.chosen);
      return ranked.filter((id) => chosen.has(id)).slice(0, input.remaining);
    }

    return ranked.slice(0, input.remaining);
  }
}
