import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { assertPlatformPermission } from 'src/modules/accounts/application/platform-authorization';
import type { PlatformPermission } from 'src/modules/accounts/domain/platform-rbac';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  OrganizationAdsSettingsPortInterface,
  OrganizationQuotaOverrides,
  OrganizationQuotaPatch,
  OrganizationQuotaPortInterface,
  OrganizationsRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import {
  OrganizationQuotaOutputDto,
  UpdateOrganizationQuotaInputDto,
} from '../dtos/organization-quota.dto';

/**
 * Lê e grava o **teto negociado** de uma organização.
 *
 * ## Por que é operador, e não dono da organização
 *
 * Este é o único lugar do sistema em que uma organização passa a valer mais do
 * que o plano publica — é o contrato entrando no produto. Deixá-lo com o dono da
 * organização seria deixar o cliente escolher o próprio teto, que é o oposto de
 * negociá-lo. A checagem é a mesma de `CreatePlanUseCase`, e por isso é feita
 * aqui e não numa guarda: quem define preço e quem define teto respondem à
 * mesma pergunta.
 *
 * ## Por que audita
 *
 * Alterar um teto move dinheiro — liberar 200 contas de anúncios é entrega que
 * ninguém cobrou. Sem trilha, não há como dizer quem liberou o quê, para quem,
 * nem quando.
 */
@Injectable()
export class ManageOrganizationQuotaUseCase {
  constructor(
    private readonly organizationsRepository: OrganizationsRepositoryInterface,
    private readonly quotas: OrganizationQuotaPortInterface,
    /**
     * O teto de gasto mora noutra tabela e no mesmo contrato.
     *
     * `organization_ads_settings` guarda duas coisas de donos diferentes: a
     * janela de análise, que é do cliente, e o teto diário de IA, que é do
     * comercial. Este caso de uso alcança só a segunda, pela porta — misturar
     * as duas numa rota só entregaria ao cliente a chave do próprio teto.
     */
    private readonly adsSettings: OrganizationAdsSettingsPortInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async read(
    organizationId: string,
    actorId: string,
  ): Promise<OrganizationQuotaOutputDto> {
    await this.assertActor(actorId, 'orgs:read');
    await this.assertOrganizationExists(organizationId);

    const [overrides, llmDailyBudgetBase] = await Promise.all([
      this.quotas.findOverrides(organizationId),
      this.adsSettings.findLlmDailyBudget(organizationId),
    ]);

    return this.present(organizationId, overrides, llmDailyBudgetBase);
  }

  async update(
    organizationId: string,
    input: UpdateOrganizationQuotaInputDto,
    actorId: string,
  ): Promise<OrganizationQuotaOutputDto> {
    // Financeiro, não operações: limite contratado é cláusula comercial.
    await this.assertActor(actorId, 'orgs:quota_manage');
    await this.assertOrganizationExists(organizationId);

    const [beforeQuotas, beforeBudget] = await Promise.all([
      this.quotas.findOverrides(organizationId),
      this.adsSettings.findLlmDailyBudget(organizationId),
    ]);

    const after = await this.quotas.upsertOverrides(
      organizationId,
      this.toPatch(input),
    );

    /**
     * Campo ausente não mexe no teto; `null` o remove. É a mesma distinção de
     * três estados das cotas, e ela vale ainda mais aqui: um `undefined` tratado
     * como `null` apagaria a parede de gasto de uma organização em toda
     * requisição que corrigisse outro número.
     */
    const afterBudget =
      input.llmDailyBudgetBase === undefined
        ? beforeBudget
        : await this.adsSettings.updateLlmDailyBudget(
            organizationId,
            input.llmDailyBudgetBase,
          );

    const before = { ...beforeQuotas, llmDailyBudgetBase: beforeBudget };

    await this.auditLog.record({
      event: 'organization.quota.updated',
      entityType: 'organization',
      entityId: organizationId,
      actorId,
      organizationId,
      // O par antes/depois, e não só o resultado: a pergunta que se faz a uma
      // trilha de teto é "o que mudou", e um retrato final sozinho não responde.
      metadata: {
        before,
        after: { ...after, llmDailyBudgetBase: afterBudget },
      },
    });

    return this.present(organizationId, after, afterBudget);
  }

  /**
   * Traduz o DTO para o patch da porta preservando os três estados.
   *
   * `undefined` (campo ausente) não pode virar `null` no caminho, senão uma
   * requisição que corrige um teto apagaria os outros.
   */
  private toPatch(
    input: UpdateOrganizationQuotaInputDto,
  ): OrganizationQuotaPatch {
    return {
      ...(input.maxAdAccounts !== undefined
        ? { adAccounts: input.maxAdAccounts }
        : {}),
      ...(input.maxMonitoredAds !== undefined
        ? { monitoredAds: input.maxMonitoredAds }
        : {}),
      ...(input.maxSeats !== undefined ? { seats: input.maxSeats } : {}),
      ...(input.maxOrganizations !== undefined
        ? { organizations: input.maxOrganizations }
        : {}),
      ...(input.maxCopyGenerationsMonthly !== undefined
        ? { copyGenerations: input.maxCopyGenerationsMonthly }
        : {}),
      ...(input.maxCreativeAnalysesMonthly !== undefined
        ? { creativeAnalyses: input.maxCreativeAnalysesMonthly }
        : {}),
    };
  }

  private present(
    organizationId: string,
    overrides: OrganizationQuotaOverrides,
    llmDailyBudgetBase: number | null,
  ): OrganizationQuotaOutputDto {
    return {
      organizationId,
      maxAdAccounts: overrides.adAccounts,
      maxMonitoredAds: overrides.monitoredAds,
      maxSeats: overrides.seats,
      maxOrganizations: overrides.organizations,
      maxCopyGenerationsMonthly: overrides.copyGenerations,
      maxCreativeAnalysesMonthly: overrides.creativeAnalyses,
      llmDailyBudgetBase,
    };
  }

  /**
   * Era a **segunda fonte da verdade**: uma cópia privada do `if` de
   * operador, com os dois papéis escritos à mão, mesmo depois de
   * `PlatformRoleService` existir para consolidá-las. Agora é a mesma regra
   * de toda superfície administrativa — importada como função, e não
   * injetada, porque `AccountsModule` já importa `OrganizationsModule` e a
   * volta fecharia um ciclo.
   */
  private async assertActor(
    actorId: string,
    permission: PlatformPermission,
  ): Promise<void> {
    const actor = await this.accountsRepository.findById(actorId);

    if (!actor) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    assertPlatformPermission(actor, permission);
  }

  private async assertOrganizationExists(
    organizationId: string,
  ): Promise<void> {
    const organization =
      await this.organizationsRepository.findById(organizationId);

    if (!organization) {
      throw new NotFoundException({
        code: 'ORGANIZATION_NOT_FOUND',
        message: 'Organization not found',
      });
    }
  }
}
