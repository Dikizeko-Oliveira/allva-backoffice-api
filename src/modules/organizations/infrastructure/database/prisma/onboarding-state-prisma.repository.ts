import { Injectable } from '@nestjs/common';
import {
  OnboardingSignals,
  OnboardingStatePortInterface,
} from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class OnboardingStatePrismaRepository implements OnboardingStatePortInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Três perguntas de existência, em paralelo.
   *
   * `findFirst` com `select: { id: true }`, e não `count`: a resposta é
   * booleana, e contar obrigaria o Postgres a varrer o resto para produzir um
   * número que ninguém lê. Esta leitura entra no caminho de `GET /auth/me`, que
   * é chamado em toda navegação.
   */
  async readSignals(organizationId: string): Promise<OnboardingSignals> {
    const [integration, adAccount, ad] = await Promise.all([
      this.prisma.integration.findFirst({
        where: { organizationId, status: 'CONNECTED' },
        select: { id: true },
      }),

      /**
       * `integrationId: { not: null }` é o que distingue vinculada de
       * descoberta: a coluna é nullable porque a credencial é substituível
       * (REBIND), e uma conta sem credencial corrente não sincroniza.
       *
       * **Congelamento por teto de plano não é considerado.** A pergunta aqui é
       * "este passo do onboarding foi cumprido", e quem teve a conta congelada
       * por downgrade já o cumpriu — mandá-lo de volta para vincular outra o
       * levaria a uma tela que vai recusar por teto. Falta de vaga é assunto da
       * guarda de plano, que tem mensagem própria.
       */
      this.prisma.adAccount.findFirst({
        where: { organizationId, integrationId: { not: null } },
        select: { id: true },
      }),

      this.prisma.ad.findFirst({
        where: { organizationId },
        select: { id: true },
      }),
    ]);

    return {
      hasConnectedIntegration: integration !== null,
      hasLinkedAdAccount: adAccount !== null,
      hasSyncedAds: ad !== null,
    };
  }
}
