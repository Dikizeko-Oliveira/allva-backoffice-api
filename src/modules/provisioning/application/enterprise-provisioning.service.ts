import { randomBytes, randomUUID } from 'crypto';
import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { PLATFORM_ACCOUNT_NOT_CUSTOMER } from 'src/modules/accounts/application/platform-authorization';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { isPlatformRole } from 'src/modules/accounts/domain/platform-rbac';
import { PasswordHasherInterface } from 'src/modules/auth/domain/ports/password-hasher.port';
import { OrganizationSubscription } from 'src/modules/organizations/domain/entities';
import { SalesLead } from 'src/modules/sales-leads/domain/entities';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** O que a ativação do contrato manda provisionar. */
export type ProvisionForContractInput = {
  /** De onde vieram razão social, titular e e-mail. */
  lead: SalesLead;
  /** O plano contratado — do contrato, não do `desiredPlan` do lead. */
  planId: string;
  /** Os tetos negociados. Nulo herda o teto do plano. */
  limits: {
    maxSeats: number | null;
    maxAdAccounts: number | null;
    maxMonitoredAds: number | null;
    maxOrganizations: number | null;
    /** O teto diário de gasto com IA. Nulo é **sem teto** — ver o `create` abaixo. */
    llmDailyBudgetBase: number | null;
  };
  /**
   * O carimbo que fecha a ativação, na mesma transação.
   *
   * O **status já vem decidido** pelo agregado: quem sabe se abre agora ou fica
   * esperando a primeira baixa é o contrato, não o provisionamento. Aqui só se
   * grava o que já foi resolvido — é o que mantém a máquina de estados num
   * lugar só.
   */
  contract: { id: string; status: string; activatedAt: Date };
};

export type EnterpriseProvisioningResult = {
  organizationId: string;
  ownerAccountId: string;
  organizationSubscriptionId: string;
  alreadyProvisioned: boolean;
};

/**
 * O provisionamento de um cliente Enterprise, dirigido pelo **contrato**.
 *
 * ## O gatilho mudou, e a mudança é o ponto
 *
 * Isto era disparado por `CLOSED_WON` no lead: ganhar o negócio criava a
 * organização na hora. Ganhar e ativar são dois atos com a assinatura de um
 * documento entre eles — e um deles pode acontecer semanas depois do outro, ou
 * nunca. Agora quem dispara é `POST /admin/contracts/:id/activate`, e o que
 * chega aqui já traz o plano contratado e os tetos negociados.
 *
 * ## O que ele grava, numa transação só
 *
 * Organização, conta do titular, participação OWNER, configuração de ads,
 * assinatura da organização, **cotas negociadas** e o carimbo no contrato.
 * Qualquer falha desfaz tudo — e é idempotente, então reativar um contrato já
 * provisionado devolve a mesma organização sem duplicar nada.
 *
 * ## A assinatura nasce ACTIVE, sem prazo
 *
 * Isto gravava `TRIALING` com quatorze dias, e o job de expiração de trials
 * fechava o acesso de um cliente que tinha acabado de assinar contrato.
 * `onPlan()` existe para este caso: `ACTIVE`, `trialEndsAt` nulo. Quem responde
 * "até quando" é a vigência do contrato, lida pelo resolver de entitlement —
 * duplicar a data aqui criaria uma segunda casa que envelhece na primeira
 * renegociação.
 */
@Injectable()
export class EnterpriseProvisioningService {
  private readonly logger = new Logger(EnterpriseProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
  ) {}

  async provisionForContract(
    input: ProvisionForContractInput,
  ): Promise<EnterpriseProvisioningResult> {
    const { lead } = input;

    /**
     * Idempotência #1: **este contrato** já foi ativado.
     *
     * A condição era "este lead já foi provisionado", e a renovação a
     * atravessou: ela é um contrato novo no mesmo lead, então o atalho
     * disparava e o sucessor ficava em `SIGNED` para sempre — o cliente perdia
     * o acesso na virada, que é exatamente o dia em que renovar deveria
     * protegê-lo. Os tetos renegociados também nunca desciam para a cota.
     *
     * `activatedAt` é o carimbo que só a ativação escreve, e é ele que separa
     * "já rodou para este contrato" de "já existe cliente aqui" — a segunda
     * afirmação é verdadeira numa renovação e não deve interromper nada. Todo o
     * resto do caminho já reusa o que existe: conta, organização, participação,
     * configuração de ads e assinatura.
     */
    const alreadyActivated = await this.prisma.enterpriseContract.findUnique({
      where: { id: input.contract.id },
      select: { activatedAt: true, organizationId: true },
    });

    if (alreadyActivated?.activatedAt && alreadyActivated.organizationId) {
      const subscription =
        await this.prisma.organizationSubscription.findUnique({
          where: { organizationId: alreadyActivated.organizationId },
        });

      return {
        organizationId: alreadyActivated.organizationId,
        ownerAccountId: lead.accountId ?? '',
        organizationSubscriptionId: subscription?.id ?? '',
        alreadyProvisioned: true,
      };
    }

    // Resolve the owner account; if none exists yet, pre-hash a random password
    // (async, kept out of the transaction) so it can be created atomically.
    const existingOwner = await this.resolveOwnerAccount(lead);

    /**
     * O e-mail do lead é de um operador — tipicamente alguém do time testando
     * o fluxo com o próprio e-mail. Provisionar tornaria o operador OWNER de
     * uma organização de cliente, que é a conta híbrida que o produto recusa
     * em toda outra porta. 409 e não 403: quem ativa é administrador, com
     * permissão; o conflito é do dado, e a saída é trocar o e-mail do lead.
     */
    if (existingOwner && isPlatformRole(existingOwner.role)) {
      throw new ConflictException({
        code: PLATFORM_ACCOUNT_NOT_CUSTOMER,
        message:
          'O e-mail deste lead pertence a uma conta de operador. Use outro e-mail para o responsável do cliente.',
      });
    }
    const newAccountPasswordHash = existingOwner
      ? null
      : await this.passwordHasher.hash(randomBytes(32).toString('base64url'));

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      // 1. Owner account
      let ownerAccountId: string;

      if (existingOwner) {
        ownerAccountId = existingOwner.id;
      } else {
        ownerAccountId = randomUUID();
        await tx.account.create({
          data: {
            id: ownerAccountId,
            name: lead.fullName,
            email: lead.workEmail.trim().toLowerCase(),
            passwordHash: newAccountPasswordHash as string,
            // The address was validated through the sales process, so the owner
            // is not sent through the self-service email confirmation — it would
            // otherwise lock them out of the account we just provisioned.
            emailVerified: true,
            emailVerifiedAt: now,
          },
        });
      }

      // Every account needs a Preference row to be reachable by preference-gated
      // email (M-7); provisioned owners bypass the normal signup path.
      await tx.preference.upsert({
        where: { accountId: ownerAccountId },
        update: {},
        create: { id: randomUUID(), accountId: ownerAccountId },
      });

      // 2. Organization (reuse if the owner already owns one — duplicate guard)
      // `findFirst`, e não `findUnique`: `owner_id` deixou de ser único quando o
      // Enterprise passou a poder ter várias organizações. O reuso continua
      // pegando a mais antiga, que é a que o provisionamento já havia criado.
      //
      // **O reuso olha posse, e só posse** — deliberadamente diferente do
      // `OrganizationProvisioningService`, que pergunta "alcança alguma". Uma
      // holding cujo signatário por acaso participa da organização de outro
      // cliente precisa de organização nova; reusar aquela entregaria a
      // fronteira de dado alheia junto com o contrato.
      //
      // `deleted_at` entrou no filtro depois: sem ele, um segundo lead do mesmo
      // dono reusava uma organização apagada — e o `RESTRICT` da FK de
      // `organization_ads_settings` deixaria o cliente com um contrato apontando
      // para algo que o produto trata como inexistente.
      const existingOrganization = await tx.organization.findFirst({
        where: { ownerId: ownerAccountId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      });

      let organizationId: string;

      if (existingOrganization) {
        organizationId = existingOrganization.id;
      } else {
        organizationId = randomUUID();
        await tx.organization.create({
          data: {
            id: organizationId,
            ownerId: ownerAccountId,
            name: lead.companyName,
            // Razão social colhida no processo comercial: nome declarado por
            // humano, como o do modal. Só o do cadastro self-serve nasce
            // derivado e por confirmar.
            nameConfirmedAt: now,
          },
        });
        await tx.auditLog.create({
          data: {
            id: randomUUID(),
            event: 'organization.created',
            entityType: 'organization',
            entityId: organizationId,
            actorId: ownerAccountId,
            organizationId,
            metadata: { leadId: lead.id, name: lead.companyName },
          },
        });
      }

      // 3. OWNER membership (ACTIVE) — create only if absent
      const existingMembership = await tx.organizationUser.findUnique({
        where: {
          organizationId_accountId: {
            organizationId,
            accountId: ownerAccountId,
          },
        },
      });

      if (!existingMembership) {
        await tx.organizationUser.create({
          data: {
            id: randomUUID(),
            organizationId,
            accountId: ownerAccountId,
            role: 'OWNER',
            status: 'ACTIVE',
          },
        });
        await tx.auditLog.create({
          data: {
            id: randomUUID(),
            event: 'owner.created',
            entityType: 'organization_user',
            entityId: ownerAccountId,
            actorId: ownerAccountId,
            organizationId,
            metadata: { leadId: lead.id, role: 'OWNER' },
          },
        });
      }

      /**
       * 3b. Ads settings — a configuração por organização de D16/A10.
       *
       * Entra na MESMA transação da organização de propósito: `activeAlgoVersion`,
       * `activeDetectorProfileVersion`, `scoringWindowDays`, `llmDailyBudgetBase`
       * e `actionDailyCap` são o que A2-S4 em diante lê para decidir *com que
       * régua* medir a mídia desta organização.
       *
       * ## Uma exceção ao "quem declara os padrões é a tabela"
       *
       * O resto continua nascendo com os DEFAULTs do schema. `llmDailyBudgetBase`
       * não pode: o default de R$ 50/dia foi calibrado para o maior plano de
       * autoatendimento, e a narrativa noturna sai para **todo score novo**. Um
       * contrato de 40.000 anúncios custa R$ 64/noite e seria cortado em ~31 mil
       * narrativas na primeira madrugada — 22% da entrega contratada, em
       * silêncio, por um número que não é dela.
       *
       * O teto do contrato vence, e nulo é **sem teto**: um contrato que ainda
       * não precificou IA não pode ser cortado por um default que não é dele.
       * `evaluateBudget` lê nulo como "permite", e o operador grava o número
       * depois — `pnpm ai:cost` dá o dado real.
       *
       * Derivar por fórmula foi considerado e recusado: embutiria uma constante
       * de custo em reais que apodrece em silêncio no primeiro reajuste.
       */
      const existingAdsSettings = await tx.organizationAdsSettings.findUnique({
        where: { organizationId },
      });

      if (!existingAdsSettings) {
        await tx.organizationAdsSettings.create({
          data: {
            organizationId,
            llmDailyBudgetBase: input.limits.llmDailyBudgetBase,
          },
        });
      }

      if (input.limits.llmDailyBudgetBase === null) {
        // Sem teto é decisão legítima, mas não pode ser decisão por omissão: o
        // log é o que faz o operador lembrar de precificar a IA do contrato.
        this.logger.warn(
          `provisioning.sem_teto_de_ia organizacao=${organizationId} ` +
            `contrato=${input.contract.id} — grave llmDailyBudgetBase quando o ` +
            'custo estiver fechado (pnpm ai:cost)',
        );
      }

      // 4. A assinatura da organização (uma por organização — idempotência #2)
      const existingSubscription = await tx.organizationSubscription.findUnique(
        {
          where: { organizationId },
        },
      );

      let organizationSubscriptionId: string;

      if (existingSubscription) {
        organizationSubscriptionId = existingSubscription.id;

        /**
         * A renovação atrasada: o contrato anterior venceu, o job revogou a
         * assinatura, e o comercial fechou o novo alguns dias depois. Reusar a
         * linha como está deixaria o cliente com um contrato ativo e uma
         * assinatura `EXPIRED` — acesso fechado por causa de uma casa que a
         * renovação deveria ter reaberto.
         */
        if (
          existingSubscription.status !== 'ACTIVE' ||
          existingSubscription.planId !== input.planId
        ) {
          await tx.organizationSubscription.update({
            where: { id: existingSubscription.id },
            data: {
              status: 'ACTIVE',
              planId: input.planId,
              // Contrato não é teste: quem responde "até quando" é a vigência.
              trialEndsAt: null,
            },
          });
        }
      } else {
        /**
         * `onPlan()`, e não `startTrial()`.
         *
         * Contrato fechado não é experimentação. A versão anterior gravava
         * `TRIALING` com quatorze dias — e `ExpireOrganizationTrialsUseCase`
         * varre exatamente esse par, `TRIALING` com data vencida, carimbando
         * `EXPIRED`: o cliente que acabou de assinar perdia o acesso no dia 15.
         */
        const subscription = OrganizationSubscription.onPlan({
          organizationId,
          planId: input.planId,
          now,
        });

        organizationSubscriptionId = subscription.id;
        await tx.organizationSubscription.create({
          data: {
            id: subscription.id,
            organizationId: subscription.organizationId,
            planId: subscription.planId,
            status: subscription.status,
            trialStartedAt: subscription.trialStartedAt,
            trialEndsAt: subscription.trialEndsAt,
          },
        });
        await tx.auditLog.create({
          data: {
            id: randomUUID(),
            event: 'subscription.created',
            entityType: 'organization_subscription',
            entityId: organizationSubscriptionId,
            actorId: ownerAccountId,
            organizationId,
            metadata: {
              leadId: lead.id,
              contractId: input.contract.id,
              planId: input.planId,
              status: subscription.status,
            },
          },
        });
      }

      /**
       * 4b. Os tetos negociados descem para a cota da organização.
       *
       * **O elo que faltava.** Sem esta escrita, o contrato de 150 assentos
       * nascia com o piso do catálogo — 25 — e alguém tinha de lembrar de
       * ajustar à mão pelo endpoint administrativo. Um acordo comercial que o
       * produto não lê é um documento, não um contrato.
       *
       * `upsert` porque a organização pode estar sendo reusada, e um aditivo
       * futuro reescreve a mesma linha. Nulo continua significando "herda o
       * plano", nunca "ilimitado" — é a regra da tabela, e o contrato não a
       * altera.
       */
      await tx.organizationQuota.upsert({
        where: { organizationId },
        update: {
          maxSeats: input.limits.maxSeats,
          maxAdAccounts: input.limits.maxAdAccounts,
          maxMonitoredAds: input.limits.maxMonitoredAds,
          maxOrganizations: input.limits.maxOrganizations,
        },
        create: {
          organizationId,
          maxSeats: input.limits.maxSeats,
          maxAdAccounts: input.limits.maxAdAccounts,
          maxMonitoredAds: input.limits.maxMonitoredAds,
          maxOrganizations: input.limits.maxOrganizations,
        },
      });

      /**
       * 4c. O contrato aponta para a organização que acabou de nascer.
       *
       * Dentro da transação de propósito: fora dela existiria uma janela em que
       * a organização está provisionada e o contrato ainda diz `SIGNED` — e o
       * resolver de entitlement leria uma organização com assinatura ativa sem
       * contrato que a justifique.
       */
      await tx.enterpriseContract.update({
        where: { id: input.contract.id },
        data: {
          organizationId,
          status: input.contract.status as never,
          activatedAt: input.contract.activatedAt,
        },
      });

      // 5. Registra a ativação e liga o lead à organização provisionada.
      await tx.auditLog.create({
        data: {
          id: randomUUID(),
          event: 'contract.activated',
          entityType: 'enterprise_contract',
          entityId: input.contract.id,
          actorId: lead.assignedTo,
          organizationId,
          metadata: {
            leadId: lead.id,
            companyName: lead.companyName,
            planId: input.planId,
            status: input.contract.status,
          },
        },
      });

      await tx.salesLead.update({
        where: { id: lead.id },
        data: {
          accountId: ownerAccountId,
          status: lead.status,
          closedWonAt: lead.closedWonAt,
          provisionedOrganizationId: organizationId,
          updatedAt: now,
        },
      });

      this.logger.log(
        `enterprise.provisioned contractId=${input.contract.id} leadId=${lead.id} organizationId=${organizationId} ownerAccountId=${ownerAccountId} subscriptionId=${organizationSubscriptionId}`,
      );

      return {
        organizationId,
        ownerAccountId,
        organizationSubscriptionId,
        alreadyProvisioned: false,
      };
    });
  }

  private async resolveOwnerAccount(lead: SalesLead) {
    if (lead.accountId) {
      const account = await this.accountsRepository.findById(lead.accountId);
      if (account) return account;
    }

    return this.accountsRepository.findByEmail(
      lead.workEmail.trim().toLowerCase(),
    );
  }
}
