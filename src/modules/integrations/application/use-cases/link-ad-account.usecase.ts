import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AdAccountsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { planLimitRefusal } from 'src/modules/plans/application/plan-limit-refusal';
import { LinkAdAccountInputDto, LinkAdAccountResponseDto } from '../dtos';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';
import { AdAccountLinkerService } from '../services/ad-account-linker.service';

@Injectable()
export class LinkAdAccountUseCase {
  constructor(
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly ownerScope: OwnerScopeResolverService,
    private readonly linker: AdAccountLinkerService,
  ) {}

  async execute(
    accountId: string,
    platform: Platform,
    input: LinkAdAccountInputDto,
  ): Promise<LinkAdAccountResponseDto> {
    if (!input.externalAccountId?.trim()) {
      throw new BadRequestException({
        code: 'EXTERNAL_ACCOUNT_ID_REQUIRED',
        message: 'externalAccountId is required',
      });
    }

    /**
     * A integração vem do **escopo da requisição**, não da conta que a criou.
     *
     * `findByAccountAndProvider(accountId, …)` só encontrava a credencial para
     * quem tinha passado pelo OAuth. Qualquer outro membro da mesma organização
     * recebia `INTEGRATION_NOT_CONNECTED` numa plataforma que `GET /integrations`
     * — org-escopada — acabara de lhe mostrar conectada.
     */
    const owner = await this.ownerScope.resolveForAccount(accountId);
    const integration = await this.ownerScope.findIntegrationForOwner(
      owner,
      platform,
    );

    if (!integration || !integration.isConnected()) {
      throw new NotFoundException({
        code: 'INTEGRATION_NOT_CONNECTED',
        message: `No connected ${platform} integration for this account`,
      });
    }

    /**
     * O plano decide **antes** de falar com a plataforma.
     *
     * Recusar depois faria a recusa custar uma chamada externa e depender de a
     * conta existir lá — e o cliente que digitou um id errado receberia
     * "não encontrada" quando o problema é que ele não tem vaga.
     */
    await this.assertPlanAllows(integration.organizationId, platform);

    const provider = this.providers.for(platform);
    const remoteAccounts = await provider.listAdAccounts(integration);
    const remote = remoteAccounts.find(
      (acc) => acc.externalAccountId === input.externalAccountId,
    );

    if (!remote) {
      throw new NotFoundException({
        code: 'AD_ACCOUNT_NOT_FOUND_REMOTE',
        message: `Ad account ${input.externalAccountId} not found on ${platform}`,
      });
    }

    /**
     * A vinculação em si é idempotente e mora no `AdAccountLinkerService`.
     *
     * Ela é a mesma para vinculação manual, religamento de credencial e
     * descoberta — e a identidade da conta é `(organizationId, platform,
     * externalAccountId)`, nunca a credencial, que desconectar zera.
     */
    const linked = await this.linker.link({
      integrationId: integration.id,
      organizationId: integration.organizationId,
      accountId,
      platform,
      externalAccountId: input.externalAccountId,
      name: input.name ?? remote.name,
      currency: remote.currency,
      timezone: remote.timezone,
    });

    return { id: linked.id };
  }

  /**
   * Duas perguntas, nesta ordem: a plataforma está no plano, e há vaga.
   *
   * A plataforma primeiro porque é a resposta mais definitiva — quem não tem
   * TikTok no plano não resolve nada liberando uma vaga.
   *
   * **A saída antecipada saiu junto com a organização opcional.** Havia aqui um
   * `if (!organizationId) return`, escrito para não quebrar integrações de
   * escopo pessoal anteriores ao multi-tenant. Ele deixou de descrever a
   * realidade quando `integrations.organization_id` virou NOT NULL, e o que
   * sobrou foi um caminho em que os dois tetos — plataforma no plano e vaga de
   * conta de anúncios — eram simplesmente pulados. Com a credencial sempre
   * carregando organização, não existe mais caso a dispensar.
   */
  private async assertPlanAllows(
    organizationId: string,
    platform: Platform,
  ): Promise<void> {
    const platformState = await this.planEntitlement.itemStateFor({
      organizationId,
      feature: 'platforms',
      item: platform,
    });

    if (!platformState.allowed) throw planLimitRefusal(platformState);

    const used =
      await this.adAccountsRepository.countActiveByOrganizationId(
        organizationId,
      );

    const quotaState = await this.planEntitlement.quotaStateFor({
      organizationId,
      feature: 'ad-accounts',
      used,
    });

    if (!quotaState.allowed) throw planLimitRefusal(quotaState);
  }
}
