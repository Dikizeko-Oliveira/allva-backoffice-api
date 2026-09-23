import { Injectable } from '@nestjs/common';
import { OrganizationPlanPortInterface } from 'src/modules/organizations/domain/ports';
import { PlanType } from 'src/modules/organizations/domain/plan-seat-limits';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * Os estados em que a organização ainda tem direito ao plano.
 *
 * Espelha `PRODUCT_ACCESS_ALLOWED` (`ALLOWED` e `GRACE_PERIOD`) depois de passar
 * por `mapBillingToAccess`: o teste corrente, a assinatura paga, e a janela de
 * atraso em que o cliente ainda não perdeu o que comprou. `PAST_DUE` entra
 * porque tirar o plano no primeiro boleto atrasado puniria quem só tem uma
 * cobrança a reprocessar.
 */
const ORG_PLAN_GRANTING_STATUSES = new Set<string>([
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
]);

@Injectable()
export class OrganizationPlanPrismaRepository implements OrganizationPlanPortInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findPlanTypeByOrganizationId(
    organizationId: string,
  ): Promise<PlanType | null> {
    const subscription = await this.readSubscriptionPlan(organizationId);

    if (!subscription) return null;

    /**
     * Um plano que não está mais valendo não é plano - é histórico.
     *
     * Esta leitura ignorava `status` e devolvia o tipo do plano fosse qual
     * fosse o estado da assinatura. Enquanto todo endpoint de produto carregar
     * `@RequireAccessStatuses`, o guard barra antes e a diferença não aparece;
     * mas isso faz a corretude de dezesseis guardas de feature depender de um
     * decorator nunca esquecido em nenhum controller novo.
     *
     * Falhando fechado aqui, o esquecimento passa a negar em vez de liberar - a
     * direção certa para errar quando a pergunta é "esta organização pode?".
     */
    if (!ORG_PLAN_GRANTING_STATUSES.has(subscription.status)) return null;

    return this.resolveEffectivePlanType(subscription);
  }

  async findContractedPlanTypeByOrganizationId(
    organizationId: string,
  ): Promise<PlanType | null> {
    const subscription = await this.readSubscriptionPlan(organizationId);

    // Sem o portão de `status`: a pergunta aqui é o que foi contratado, não o
    // que ainda vale. Ver a nota no port.
    return subscription ? this.resolveEffectivePlanType(subscription) : null;
  }

  async findPlanScheduleByOrganizationId(organizationId: string): Promise<{
    planType: PlanType | null;
    pendingPlanType: PlanType | null;
    pendingPlanEffectiveAt: Date | null;
  } | null> {
    const subscription = await this.readSubscriptionPlan(organizationId);

    if (!subscription) return null;

    return {
      planType: (subscription.plan?.type as PlanType | undefined) ?? null,
      pendingPlanType:
        (subscription.pendingPlan?.type as PlanType | undefined) ?? null,
      pendingPlanEffectiveAt: subscription.pendingPlanEffectiveAt,
    };
  }

  private async readSubscriptionPlan(organizationId: string) {
    return this.prisma.organizationSubscription.findUnique({
      where: { organizationId },
      select: {
        status: true,
        plan: { select: { type: true } },
        pendingPlanEffectiveAt: true,
        pendingPlan: { select: { type: true } },
      },
    });
  }

  /**
   * A queda agendada vira o plano vigente sozinha, na data.
   *
   * Sem isto, o downgrade só valeria quando o webhook da Stripe chegasse — e
   * enquanto não chegasse, a organização seguiria com os limites do plano que
   * deixou de pagar.
   */
  private resolveEffectivePlanType(subscription: {
    plan: { type: string } | null;
    pendingPlanEffectiveAt: Date | null;
    pendingPlan: { type: string } | null;
  }): PlanType | null {
    const due =
      subscription.pendingPlan &&
      subscription.pendingPlanEffectiveAt &&
      subscription.pendingPlanEffectiveAt <= new Date();

    const type = due ? subscription.pendingPlan?.type : subscription.plan?.type;

    return (type as PlanType | undefined) ?? null;
  }

  async scheduleDowngrade(input: {
    organizationId: string;
    planId: string;
    effectiveAt: Date;
  }): Promise<void> {
    await this.prisma.organizationSubscription.updateMany({
      where: { organizationId: input.organizationId },
      data: {
        pendingPlanId: input.planId,
        pendingPlanEffectiveAt: input.effectiveAt,
      },
    });
  }

  async applyUpgrade(input: {
    organizationId: string;
    planId: string;
  }): Promise<void> {
    const now = new Date();

    // `upsert`, e não `updateMany`: sem linha, o update não falhava — apenas não
    // fazia nada, e o cliente que acabou de pagar continuava com plano nulo.
    // `trialStartedAt` é NOT NULL no schema e `trialEndsAt` fica aberto, porque
    // quem sobe de plano pagando não está em teste nenhum.
    await this.prisma.organizationSubscription.upsert({
      where: { organizationId: input.organizationId },
      update: {
        planId: input.planId,
        status: 'ACTIVE',
        // Uma subida supera a queda que ainda não aterrissou.
        pendingPlanId: null,
        pendingPlanEffectiveAt: null,
      },
      create: {
        organizationId: input.organizationId,
        planId: input.planId,
        status: 'ACTIVE',
        trialStartedAt: now,
        trialEndsAt: null,
      },
    });
  }

  async syncPlanForOwner(input: {
    ownerAccountId: string;
    planId: string;
  }): Promise<number> {
    // Sem `pendingPlanId` no `data`: a renovação mensal entrega o mesmo evento,
    // e limpar a queda agendada aqui faria o downgrade nunca chegar.
    const { count } = await this.prisma.organizationSubscription.updateMany({
      where: {
        organization: { ownerId: input.ownerAccountId, deletedAt: null },
      },
      data: { planId: input.planId, status: 'ACTIVE' },
    });

    // `updateMany` não falha quando não encontra nada — a mesma armadilha que
    // `applyUpgrade` já levou. Aqui o chamador decide o que fazer com o zero.
    return count;
  }

  async revokeForOrganization(input: {
    organizationId: string;
    status: 'CANCELED' | 'EXPIRED';
  }): Promise<number> {
    const { count } = await this.prisma.organizationSubscription.updateMany({
      where: { organizationId: input.organizationId },
      data: { status: input.status },
    });

    return count;
  }

  async revokeForOwner(input: {
    ownerAccountId: string;
    status: 'CANCELED' | 'EXPIRED';
  }): Promise<number> {
    /**
     * `planId` fica onde está, de propósito.
     *
     * O que se perde é o **direito de acesso**, não o histórico comercial: a
     * organização continua registrando qual plano chegou a ser contratado, e
     * `status` é quem responde se ele ainda vale. Zerar o plano aqui apagaria o
     * extrato de quem já pagou e deixaria `findPlanTypeByOrganizationId` sem o
     * que devolver na reativação.
     */
    const { count } = await this.prisma.organizationSubscription.updateMany({
      where: {
        organization: { ownerId: input.ownerAccountId, deletedAt: null },
      },
      data: { status: input.status },
    });

    return count;
  }
}
