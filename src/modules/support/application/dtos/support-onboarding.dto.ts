import { ApiProperty } from '@nestjs/swagger';
import {
  SupportOnboardingStepId,
  SupportOnboardingStepValues,
} from 'src/modules/support/domain/support-onboarding';

export class SupportOnboardingStepDto {
  @ApiProperty({ enum: SupportOnboardingStepValues })
  id: SupportOnboardingStepId;

  @ApiProperty()
  completed: boolean;
}

/**
 * Só identificador e estado — **nem título, nem descrição, nem rota**.
 *
 * É a mesma divisão que `GET /auth/me` já pratica com `nextStep`: o servidor
 * publica o enum, a tela escreve a frase e sabe para onde o botão aponta.
 * Devolver `/account/integrations` daqui seria a API guardando o mapa de
 * rotas do Next — um rename de rota no frontend quebraria em produção, sem
 * nada que o acuse em build.
 */
export class SupportOnboardingOutputDto {
  @ApiProperty({ type: [SupportOnboardingStepDto] })
  steps: SupportOnboardingStepDto[];

  @ApiProperty()
  completedCount: number;

  @ApiProperty()
  totalCount: number;

  @ApiProperty({ example: 60, description: 'Inteiro de 0 a 100.' })
  progress: number;
}
