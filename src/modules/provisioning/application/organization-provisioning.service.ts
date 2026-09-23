import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import {
  Organization,
  OrganizationSubscription,
  OrganizationUser,
} from 'src/modules/organizations/domain/entities';
import {
  OrganizationsRepositoryInterface,
  OrganizationUsersRepositoryInterface,
} from 'src/modules/organizations/domain/ports';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { resolveDefaultOrganizationName } from 'src/modules/provisioning/domain/organization-name';

export type EnsureOrganizationInput = {
  accountId: string;
  accountEmail: string;
  accountName?: string | null;
  /** Vai para o audit log: de onde esta organização veio. */
  source: 'signup' | 'integration' | 'backfill';
  /**
   * O plano que a pessoa escolheu na landing antes de se cadastrar, quando
   * escolheu algum. É o que decide entre nascer no teste gratuito e nascer
   * esperando o primeiro pagamento — veja {@link OrganizationProvisioningService.startingSubscription}.
   *
   * Só o cadastro tem essa informação. `integration` e `backfill` curam
   * organização faltante para uma conta que já existe, e para elas a ausência
   * é a resposta certa: o teste é o padrão de quem não escolheu nada.
   */
  selectedPlanId?: string | null;
};

export type EnsureOrganizationResult = {
  organizationId: string;
  created: boolean;
};

/**
 * Garante que uma conta alcança **alguma** organização.
 *
 * ## Por que existe
 *
 * O produto é organization-first desde a migração ads-first: `Ad`,
 * `Integration`, waste, recomendações e ações são todos escopados por
 * `organization_id`, e `integrations.organization_id` é NOT NULL. O cadastro,
 * porém, continuou account-first — criava conta, preferência e e-mail de
 * boas-vindas, e nenhuma organização. A conta nascia num estado que o resto do
 * produto não sabe atender: dashboard vazio com "selecione uma organização",
 * tela de organização em 404, e o callback do OAuth quebrando na constraint.
 *
 * ## "Alcança", e não "possui" — e por que a venda Enterprise pergunta outra coisa
 *
 * A invariante aqui é **"a conta alcança uma organização"**. A diferença aparece
 * em quem entrou por convite: um analista de agência já tem participação ativa
 * na organização de quem o convidou, e é ela que `OwnerScopeResolverService`
 * resolve. Criar uma segunda, vazia, poria no seletor de workspace uma
 * organização que ninguém pediu e queimaria a cota `organizations` do plano
 * dele — que é 1 fora do Enterprise.
 *
 * `EnterpriseProvisioningService` faz a pergunta **oposta de propósito**, e as
 * duas não devem ser unificadas: lá a chave de idempotência é o *lead*
 * (`provisionedOrganizationId`), e o reuso olha só posse. Uma venda a uma
 * holding cujo signatário por acaso participa de outra organização precisa de
 * uma organização nova — reusar aquela seria entregar a fronteira de dado de
 * outro cliente. Políticas diferentes, respostas diferentes, cada uma no seu
 * chamador; o que os dois compartilham é o **escritor**, não a decisão.
 *
 * ## Idempotência
 *
 * A verificação precede a escrita mas não roda na mesma transação que ela — a
 * fronteira transacional pertence ao repositório (`saveWithOwner`), que é o que
 * mantém organização, configuração de ads, participação OWNER e assinatura
 * nascendo juntas.
 * `organizations.owner_id` deixou de ser único quando o Enterprise passou a
 * poder ter várias, então não há constraint para desempatar duas chamadas
 * concorrentes. É o suficiente para os chamadores reais, que são sequenciais
 * (cadastro, depois conexão de plataforma); não é exclusão mútua, e não deve ser
 * lida como tal.
 */
@Injectable()
export class OrganizationProvisioningService {
  private readonly logger = new Logger(OrganizationProvisioningService.name);

  constructor(
    private readonly organizations: OrganizationsRepositoryInterface,
    private readonly organizationUsers: OrganizationUsersRepositoryInterface,
    private readonly plans: PlansRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async ensureForAccount(
    input: EnsureOrganizationInput,
  ): Promise<EnsureOrganizationResult> {
    const existing = await this.findReachableOrganizationId(input.accountId);

    if (existing) return { organizationId: existing, created: false };

    const name = resolveDefaultOrganizationName({
      name: input.accountName,
      email: input.accountEmail,
    });

    const organization = Organization.create({
      ownerId: input.accountId,
      name,
    });

    // A posse mora em duas colunas por decisão do schema: `owner_id` nomeia o
    // criador, e é a participação OWNER que o RBAC lê. O repositório grava as
    // duas — mais a configuração de ads e a assinatura — numa transação só.
    const owner = OrganizationUser.create({
      organizationId: organization.id,
      accountId: input.accountId,
      role: 'OWNER',
      status: 'ACTIVE',
    });

    await this.organizations.saveWithOwner(
      organization,
      owner,
      await this.startingSubscription(organization.id, input.selectedPlanId),
    );

    const metadata = { name, source: input.source };

    await this.auditLog.record({
      event: 'organization.created',
      entityType: 'organization',
      entityId: organization.id,
      actorId: input.accountId,
      organizationId: organization.id,
      metadata,
    });

    await this.auditLog.record({
      event: 'owner.created',
      entityType: 'organization_user',
      entityId: owner.id,
      actorId: input.accountId,
      organizationId: organization.id,
      metadata: { ...metadata, role: 'OWNER' },
    });

    this.logger.log(
      `organization.provisioned organizationId=${organization.id} accountId=${input.accountId} source=${input.source}`,
    );

    return { organizationId: organization.id, created: true };
  }

  /**
   * A assinatura com que a organização nasce — teste gratuito ou espera de
   * pagamento, conforme o que a pessoa escolheu antes de se cadastrar.
   *
   * ## Por que existem dois caminhos
   *
   * Antes existia só o teste, e ele era dado a todo mundo — inclusive a quem
   * tinha acabado de clicar em "Profissional" na landing. O teste deixa a conta
   * `ALLOWED`, e `ALLOWED` é o estado em que o resto do produto lê "já tem
   * assinatura, então o que ela quer é **trocar** de plano": o checkout da
   * primeira assinatura (`/plans/subscriptions`) devolvia essa pessoa para
   * `/account/billing`, que por sua vez não achava assinatura de conta nenhuma
   * para trocar e a mandava de volta. Ping-pong fechado, e o banco guardando
   * `TRIALING` porque a compra nunca teve por onde acontecer.
   *
   * Quem escolheu um plano pago self-serve nasce em `PENDING_PAYMENT`: sem
   * acesso ao produto, com acesso à tela de contratação, e com a linha da
   * organização já apontando para o plano certo — inclusive se o `?next=` se
   * perder no caminho.
   *
   * ## E quem não escolheu plano pago continua no teste
   *
   * Ausência de escolha, plano gratuito e plano negociado caem todos no teste,
   * cada um por um motivo diferente. Sem escolha e no gratuito é o padrão de
   * sempre. No **Enterprise** é deliberado: ele não tem checkout self-serve
   * (`PLAN_REQUIRES_SALES_CONTACT`), a contratação é uma conversa com o
   * comercial, e deixar a conta trancada enquanto a proposta corre puniria o
   * lead mais valioso do funil pelo caminho que o próprio produto o obriga a
   * seguir.
   *
   * **Falha alto de propósito.** `ensureForAccount` é chamado de dentro de um
   * `try` best-effort no cadastro, e é tentador deixar a organização nascer sem
   * plano quando a tabela `plans` não está semeada. Seria trocar um erro
   * visível na hora — a conta segue sem organização e `provision:organizations`
   * a cura — por uma organização silenciosamente inútil, que é exatamente o
   * defeito que este serviço passou a fechar.
   */
  private async startingSubscription(
    organizationId: string,
    selectedPlanId?: string | null,
  ): Promise<OrganizationSubscription> {
    const selectedPlan = selectedPlanId
      ? await this.plans.findById(selectedPlanId)
      : null;

    // O cadastro por senha já recusa id fora do catálogo (`PLAN_NOT_FOUND`),
    // antes de a conta existir. Esta rede fica para as portas que não passam
    // por ali - contas antigas, provisionamento em lote -, onde travar seria
    // pior: sem plano válido, a organização nasce no teste.
    if (selectedPlan && this.requiresCheckout(selectedPlan)) {
      return OrganizationSubscription.awaitingFirstPayment({
        organizationId,
        planId: selectedPlan.id,
      });
    }

    return this.startTrial(organizationId);
  }

  /**
   * O plano se contrata sozinho, no cartão, agora?
   *
   * `contactSalesOnly` é a fonte da verdade e não o tipo: o catálogo pode marcar
   * qualquer plano como negociado, e um `type === 'ENTERPRISE'` cravado aqui
   * deixaria de valer no dia em que isso acontecesse com o Profissional.
   */
  private requiresCheckout(plan: {
    type: string;
    contactSalesOnly?: boolean | null;
  }): boolean {
    return plan.type !== 'FREE' && !plan.contactSalesOnly;
  }

  /**
   * O teste gratuito com que a organização nasce quando ninguém escolheu um
   * plano pago.
   *
   * O FREE espelha o PRO (`TRIAL_MIRRORS`): o teste entrega o produto inteiro e
   * a parede é o calendário — quem nunca pausou um anúncio não tem do que sentir
   * falta no dia 15. É por isso que a organização recém-criada precisa desta
   * linha e não de nenhuma permissão especial: é ela que faz `planAllows`
   * responder "sim" às dezesseis chaves aplicadas.
   */
  private async startTrial(
    organizationId: string,
  ): Promise<OrganizationSubscription> {
    const plan = await this.plans.findByType('FREE');

    if (!plan) {
      throw new NotFoundException({
        code: 'PLAN_NOT_CONFIGURED',
        message: 'No FREE plan is configured to start the organization trial',
      });
    }

    return OrganizationSubscription.startTrial({
      organizationId,
      planId: plan.id,
      trialDays: plan.trialDays,
    });
  }

  /**
   * A mesma ordem de `OwnerScopeResolverService.resolveDefaultScope` —
   * participação primeiro, posse depois —, com **uma diferença deliberada**:
   * participação congelada conta aqui, e lá não.
   *
   * `isActive()` recusa quem `frozen_at` alcançou, porque congelamento é teto de
   * assentos do plano. Herdar essa recusa nesta busca criaria uma organização
   * nova para quem acabou de perder a vaga — um contorno do teto, produzido pelo
   * próprio serviço que deveria ser neutro. A pergunta aqui não é "pode agir",
   * é "já pertence a algum lugar"; congelado pertence. Por isso o filtro é
   * `status`, e não `isActive()`.
   *
   * `INVITED` não conta: o convite ainda não foi aceito, e uma participação que
   * nenhum guard aceita deixaria a conta sem workspace utilizável.
   */
  private async findReachableOrganizationId(
    accountId: string,
  ): Promise<string | null> {
    // `listByAccountId` já exclui participação com soft delete e ordena por
    // `createdAt`, então a primeira que sobreviver aos filtros é a de
    // referência.
    const memberships = (
      await this.organizationUsers.listByAccountId(accountId)
    ).filter((membership) => membership.status === 'ACTIVE');

    if (memberships.length > 0) {
      // A participação sobrevive à organização apagada, então a existência de
      // uma não prova a da outra: `listByIds` descarta soft-deleted, e o que
      // não voltar de lá não é alcançável.
      const alive = new Set(
        (
          await this.organizations.listByIds(
            memberships.map((membership) => membership.organizationId),
          )
        ).map((organization) => organization.id),
      );

      const reachable = memberships.find((membership) =>
        alive.has(membership.organizationId),
      );

      if (reachable) return reachable.organizationId;
    }

    // Já filtra `deleted_at` e devolve a mais antiga.
    const owned = await this.organizations.findByOwnerId(accountId);

    return owned?.id ?? null;
  }
}
