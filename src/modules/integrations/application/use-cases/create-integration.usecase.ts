import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { CreateIntegrationInputDto, CreateIntegrationOutputDto } from '../dtos';
import { Integration } from 'src/modules/integrations/domain/entities';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { OrganizationProvisioningService } from 'src/modules/provisioning/application/organization-provisioning.service';
import { AuditLogService } from 'src/modules/audit/application';
import { Platform } from 'src/modules/integrations/domain/entities/platform';
import { OwnerScopeResolverService } from '../services/owner-scope-resolver.service';

@Injectable()
export class CreateIntegrationUseCase {
  constructor(
    private readonly integrationsRepository: IntegrationsRepositoryInterface,
    private readonly organizationProvisioning: OrganizationProvisioningService,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
    private readonly ownerScope: OwnerScopeResolverService,
  ) {}

  /**
   * @param selectedOrganizationId Organização escolhida na ida do OAuth, lida do
   * `state` assinado. Quando presente e ainda acessível, é ela que recebe a
   * credencial — sem isso a organização era adivinhada no retorno pela
   * participação ativa mais antiga, e quem participa de mais de uma conectava na
   * organização errada sem nenhum sinal de que isso aconteceu.
   */
  async execute(
    input: CreateIntegrationInputDto,
    accountId: string,
    selectedOrganizationId: string | null = null,
  ): Promise<CreateIntegrationOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    /**
     * A organização é **garantida**, não procurada.
     *
     * Antes eram duas buscas — organização própria, senão a primeira
     * participação — e o resultado alimentava um `organizationId` opcional. Numa
     * conta sem nenhuma das duas o resultado era `undefined`, e a credencial ia
     * para o banco com `organization_id` nulo contra uma coluna NOT NULL: o
     * INSERT falhava **depois** de a plataforma ter trocado o code por token, ou
     * seja, com o consentimento já concedido e nada gravado.
     *
     * Provisionar aqui não é atalho de conveniência: é o mesmo serviço do
     * cadastro, idempotente, e este é o último ponto em que a ausência ainda
     * pode ser corrigida sem custo para quem está conectando. Contas criadas
     * antes deste provisionamento existir chegam aqui sem organização, e é aqui
     * que elas ganham a sua.
     */
    /**
     * A escolha do usuário vence a adivinhação — depois de revalidada.
     *
     * `resolveForAccount` reconfere o acesso à organização pedida e, se ela não
     * resolver mais (participação revogada entre a ida e a volta, id obsoleto),
     * cai no escopo padrão em vez de vazar. Só quando não há escolha alguma é
     * que o provisionamento decide, como antes.
     */
    const selected = selectedOrganizationId
      ? await this.ownerScope.resolveForAccount(
          accountId,
          selectedOrganizationId,
        )
      : null;

    const organizationId =
      selected?.organizationId ??
      (
        await this.organizationProvisioning.ensureForAccount({
          accountId,
          accountName: account.name,
          accountEmail: account.email,
          source: 'integration',
        })
      ).organizationId;

    /**
     * A credencial existente é procurada **dentro da organização** que vai
     * recebê-la.
     *
     * `findByAccountAndProvider` era por conta: conectar a Meta na organização B
     * encontrava a credencial da organização A e sobrescrevia o token dela —
     * mover credencial entre organizações por engano é a mesma família de
     * problema que gravar na organização errada.
     */
    const existing = await this.ownerScope.findIntegrationForOwner(
      { accountId, organizationId },
      input.providerType as Platform,
    );

    if (existing) {
      existing.updateTokens({
        accessToken: input.accessToken,
        refreshToken: input.refreshToken,
        expiresAt: new Date(input.expiresAt),
      });
      await this.integrationsRepository.update(existing);

      // Distinct from `connected`: re-authorising an existing integration is a
      // different event from granting access for the first time.
      await this.auditLog.record({
        event: 'integration.reconnected',
        entityType: 'integration',
        entityId: existing.id,
        actorId: accountId,
        organizationId: existing.organizationId,
        metadata: {
          provider: input.provider,
          providerType: input.providerType,
        },
      });

      return { id: existing.id };
    }

    const integration = Integration.create({
      accountId,
      organizationId,
      provider: input.provider,
      providerType: input.providerType,
      accessToken: input.accessToken,
      refreshToken: input.refreshToken,
      expiresAt: new Date(input.expiresAt),
      name: input.name,
    });

    await this.integrationsRepository.save(integration);

    // Connecting an ad platform grants this application access to real ad spend.
    await this.auditLog.record({
      event: 'integration.connected',
      entityType: 'integration',
      entityId: integration.id,
      actorId: accountId,
      organizationId: integration.organizationId,
      metadata: { provider: input.provider, providerType: input.providerType },
    });

    return { id: integration.id };
  }
}
