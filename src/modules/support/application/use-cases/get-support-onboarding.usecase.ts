import { Injectable } from '@nestjs/common';
import { OnboardingStatePortInterface } from 'src/modules/organizations/domain/ports';
import { SupportOnboardingSignalsPortInterface } from 'src/modules/support/domain/ports';
import { resolveSupportOnboarding } from 'src/modules/support/domain/support-onboarding';
import { SupportCenterAccessService } from '../services/support-center-access.service';
import { SupportOnboardingOutputDto } from '../dtos';

/**
 * `GET /api/v1/support/onboarding` — a tela "Primeiros passos".
 *
 * Duas portas, de propósito. `OnboardingStatePortInterface` é a **mesma** que
 * `GET /auth/me` lê para decidir o próximo passo do produto: integração
 * conectada, conta vinculada e anúncio sincronizado saem de lá, e não de uma
 * segunda consulta escrita aqui — dois lugares respondendo "a integração está
 * de pé?" é como a dashboard e esta tela passariam a discordar.
 * `SupportOnboardingSignalsPortInterface` cobre só o que esta tela pergunta e
 * aquela não: perfil da empresa, time e preferências de notificação.
 *
 * Guardado por `support-onboarding` e não por `support-dedicated-channel`
 * porque é essa a linha que o catálogo vende ("Onboarding assistido"). As
 * duas são Enterprise hoje; nomear a certa é o que mantém a guarda válida se
 * um dia deixarem de ser a mesma coisa.
 */
@Injectable()
export class GetSupportOnboardingUseCase {
  constructor(
    private readonly productSignals: OnboardingStatePortInterface,
    private readonly supportSignals: SupportOnboardingSignalsPortInterface,
    private readonly access: SupportCenterAccessService,
  ) {}

  async execute(input: {
    accountId: string;
    organizationId: string | null;
  }): Promise<SupportOnboardingOutputDto> {
    const organizationId = await this.access.assert(
      input.organizationId,
      'support-onboarding',
    );

    const [product, signals] = await Promise.all([
      this.productSignals.readSignals(organizationId),
      this.supportSignals.readSignals({
        organizationId,
        accountId: input.accountId,
      }),
    ]);

    return resolveSupportOnboarding(signals, product);
  }
}
