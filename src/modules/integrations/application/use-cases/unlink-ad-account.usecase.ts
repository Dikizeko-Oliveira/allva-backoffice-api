import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdAccountsRepositoryInterface,
  IntegrationsRepositoryInterface,
} from 'src/modules/integrations/domain/ports';
import {
  Platform,
  platformToProviderType,
} from 'src/modules/integrations/domain/entities/platform';
import { UnlinkAdAccountResponseDto } from '../dtos';
import { AuditLogService } from 'src/modules/audit/application';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';

@Injectable()
export class UnlinkAdAccountUseCase {
  constructor(
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly adAccountsRepository: AdAccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  async execute(
    accountId: string,
    platform: Platform,
    adAccountId: string,
  ): Promise<UnlinkAdAccountResponseDto> {
    const owner = await this.ownerScope.resolveForAccount(accountId);
    const adAccount = await this.adAccountsRepository.findById(adAccountId);

    if (!adAccount) {
      throw new NotFoundException({
        code: 'AD_ACCOUNT_NOT_FOUND',
        message: 'Ad account not found',
      });
    }

    // Já desvinculada: não há integração para autorizar contra, e desvincular
    // de novo não é erro — é a mesma resposta que o cliente já obteve.
    const integration = adAccount.integrationId
      ? await this.integrationsRepository.findById(adAccount.integrationId)
      : null;

    /**
     * A autorização é por **escopo**, não por quem criou a credencial.
     *
     * `integration.accountId !== accountId` recusava a remoção para todo membro
     * que não fosse quem conectou a plataforma — inclusive o dono da
     * organização, quando quem conectou tinha sido um convidado. A tela oferecia
     * o botão (a lista é org-escopada) e a API respondia 403.
     */
    if (
      !integration ||
      !this.ownerScope.isIntegrationOwned(owner, integration)
    ) {
      throw new ForbiddenException({
        code: 'AD_ACCOUNT_FORBIDDEN',
        message: 'Ad account does not belong to this account',
      });
    }

    if (integration.providerType !== platformToProviderType(platform)) {
      throw new ForbiddenException({
        code: 'AD_ACCOUNT_PLATFORM_MISMATCH',
        message: 'Ad account does not belong to this platform',
      });
    }

    adAccount.detachIntegration();
    await this.adAccountsRepository.update(adAccount);

    await this.auditLog.record({
      event: 'ad_account.unlinked',
      entityType: 'ad_account',
      entityId: adAccount.id,
      actorId: accountId,
      organizationId: integration.organizationId,
      metadata: { platform, integrationId: integration.id },
    });

    return { id: adAccount.id, active: adAccount.isActive() };
  }
}
