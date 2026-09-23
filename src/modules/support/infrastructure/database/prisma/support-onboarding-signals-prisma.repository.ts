import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { SupportOnboardingSignals } from 'src/modules/support/domain/support-onboarding';
import { SupportOnboardingSignalsPortInterface } from 'src/modules/support/domain/ports';

@Injectable()
export class SupportOnboardingSignalsPrismaRepository implements SupportOnboardingSignalsPortInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Quatro perguntas de existência, em paralelo — a mesma forma de
   * `OnboardingStatePrismaRepository`.
   *
   * `findFirst` com `select` mínimo em vez de `count`: a resposta é booleana, e
   * contar obrigaria o Postgres a varrer o resto para produzir um número que
   * ninguém lê.
   */
  async readSignals(input: {
    organizationId: string;
    accountId: string;
  }): Promise<SupportOnboardingSignals> {
    const { organizationId, accountId } = input;

    const [organization, teammate, invitation, preference] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { nameConfirmedAt: true, cnpj: true, phone: true },
      }),

      /**
       * Outra pessoa, não outro vínculo: `accountId: { not: accountId }` é o
       * que distingue "convidei alguém" de "sou o dono". Participação
       * `REMOVED` fica de fora — quem removeu o único convidado voltou ao
       * ponto de partida —, mas `INVITED` conta: o convite foi aceito e a
       * pessoa ainda não entrou, e o passo é convidar.
       */
      this.prisma.organizationUser.findFirst({
        where: {
          organizationId,
          accountId: { not: accountId },
          status: { not: 'REMOVED' },
          deletedAt: null,
        },
        select: { id: true },
      }),

      /**
       * O convite ainda de pé cobre a janela entre enviar e aceitar. Expirado
       * não conta: um convite que morreu sem resposta deixou o time do mesmo
       * tamanho, e marcar o passo esconderia justamente o reenvio que falta.
       */
      this.prisma.organizationInvitation.findFirst({
        where: {
          organizationId,
          acceptedAt: null,
          revokedAt: null,
          deletedAt: null,
          expiresAt: { gt: new Date() },
        },
        select: { id: true },
      }),

      /**
       * `reviewed_at`, e não a existência da linha: toda conta nasce com uma
       * (ver o sinal em `SupportOnboardingSignals`). É a única das quatro
       * consultas que precisa de um campo, e não de um `id`.
       */
      this.prisma.preference.findUnique({
        where: { accountId },
        select: { reviewedAt: true },
      }),
    ]);

    return {
      organizationProfileComplete:
        organization?.nameConfirmedAt !== null &&
        organization?.nameConfirmedAt !== undefined &&
        Boolean(organization.cnpj ?? organization.phone),
      teamInvited: teammate !== null || invitation !== null,
      notificationPreferencesSet: preference?.reviewedAt != null,
    };
  }
}
