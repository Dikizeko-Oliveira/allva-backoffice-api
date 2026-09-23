import { Injectable } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { OrganizationAdsSettingsPortInterface } from 'src/modules/organizations/domain/ports';
import {
  MAX_SCORING_WINDOW_DAYS,
  MIN_SCORING_WINDOW_DAYS,
} from 'src/modules/organizations/domain/ports';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import {
  OrganizationAdsSettingsOutputDto,
  UpdateOrganizationAdsSettingsInputDto,
} from '../dtos/organization-ads-settings.dto';

/**
 * Lê e grava a **janela de análise** da organização.
 *
 * ## Por que é do dono da organização, e não do operador
 *
 * Ao contrário do teto negociado, esta configuração não move dinheiro nem
 * contorna o plano: ela diz o que a *própria* organização considera recente ao
 * medir a mídia dela. Uma agência que roda campanhas de 30 dias e outra que
 * gira criativo toda semana não têm a mesma resposta, e nenhuma das duas
 * precisa abrir chamado para dizer isso.
 *
 * ## Por que audita
 *
 * Ela reescreve a régua de todas as telas de inteligência, e o efeito só
 * aparece no ciclo de scoring seguinte. Quando alguém perguntar por que o
 * desperdício da organização mudou de patamar numa terça sem que campanha
 * nenhuma tenha mudado, a trilha é o que responde.
 */
@Injectable()
export class ManageOrganizationAdsSettingsUseCase {
  constructor(
    private readonly settings: OrganizationAdsSettingsPortInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async read(
    org: OrganizationContext,
  ): Promise<OrganizationAdsSettingsOutputDto> {
    const current = await this.settings.find(org.organizationId);
    return this.present(current.scoringWindowDays);
  }

  async update(
    org: OrganizationContext,
    input: UpdateOrganizationAdsSettingsInputDto,
  ): Promise<OrganizationAdsSettingsOutputDto> {
    const before = await this.settings.find(org.organizationId);
    const after = await this.settings.updateScoringWindowDays(
      org.organizationId,
      input.scoringWindowDays,
    );

    // Gravação sem mudança não vira evento: uma trilha cheia de linhas em que
    // nada mudou é uma trilha em que ninguém procura.
    if (before.scoringWindowDays !== after.scoringWindowDays) {
      await this.auditLog.record({
        event: 'organization.ads_settings.updated',
        entityType: 'organization',
        entityId: org.organizationId,
        actorId: org.accountId,
        organizationId: org.organizationId,
        metadata: {
          before: { scoringWindowDays: before.scoringWindowDays },
          after: { scoringWindowDays: after.scoringWindowDays },
        },
      });
    }

    return this.present(after.scoringWindowDays);
  }

  /**
   * Os limites viajam junto com o valor. Sem eles o cliente teria de repetir 7 e
   * 90 do próprio lado, e o dia em que o piso mudar aqui a tela ainda ofereceria
   * o antigo — a validação e o que a interface oferece deixariam de ser a mesma
   * regra.
   */
  private present(scoringWindowDays: number): OrganizationAdsSettingsOutputDto {
    return {
      scoringWindowDays,
      minScoringWindowDays: MIN_SCORING_WINDOW_DAYS,
      maxScoringWindowDays: MAX_SCORING_WINDOW_DAYS,
    };
  }
}
