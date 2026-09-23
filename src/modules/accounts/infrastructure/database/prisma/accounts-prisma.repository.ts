import { Injectable } from '@nestjs/common';
import { ACCOUNT_ROLE_TYPE } from 'generated/prisma/client';
import { Account } from 'src/modules/accounts/domain/entities';
import type { PlatformRole } from 'src/modules/accounts/domain/platform-rbac';
import {
  AccountsRepositoryInterface,
  ChangePlatformStatusResult,
  ChangePlatformRoleResult,
  OwnedOrganization,
  PlatformAccountStatus,
  UpdateAccountProps,
} from 'src/modules/accounts/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AccountsPrismaRepository implements AccountsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<Account | null> {
    // `findFirst`, e não `findUnique`: o filtro por conta encerrada não cabe num
    // lookup por chave única. É o que faz login, recuperação de senha e entrada
    // por Google/Facebook não reencontrarem uma conta anonimizada — o e-mail
    // real já não está na linha, e este filtro é a segunda tranca.
    const record = await this.prisma.account.findFirst({
      where: { email, deletedAt: null },
    });

    if (!record) return null;

    return Account.restore({
      id: record.id,
      name: record.name,
      email: record.email,
      selectedPlanId: record.selectedPlanId ?? undefined,
      stripeCustomerId: record.stripeCustomerId ?? undefined,
      role: record.role,
      cpf: record.cpf ?? undefined,
      phone: record.phone ?? undefined,
      address: record.address ?? undefined,
      addressNumber: record.addressNumber ?? undefined,
      addressComplement: record.addressComplement ?? undefined,
      addressCity: record.addressCity ?? undefined,
      avatarUrl: record.avatarUrl ?? undefined,
      passwordHash: record.passwordHash,
      emailVerified: record.emailVerified,
      emailVerifiedAt: record.emailVerifiedAt,
      platformSuspendedAt: record.platformSuspendedAt,
      platformSuspendedBy: record.platformSuspendedBy,
      platformSuspendedReason: record.platformSuspendedReason,
      createdAt: record.createdAt,
    });
  }

  async findById(id: string): Promise<Account | null> {
    const record = await this.prisma.account.findUnique({
      where: { id },
    });

    if (!record) return null;

    return Account.restore({
      id: record.id,
      name: record.name,
      email: record.email,
      selectedPlanId: record.selectedPlanId ?? undefined,
      stripeCustomerId: record.stripeCustomerId ?? undefined,
      role: record.role,
      cpf: record.cpf ?? undefined,
      phone: record.phone ?? undefined,
      address: record.address ?? undefined,
      addressNumber: record.addressNumber ?? undefined,
      addressComplement: record.addressComplement ?? undefined,
      addressCity: record.addressCity ?? undefined,
      avatarUrl: record.avatarUrl ?? undefined,
      passwordHash: record.passwordHash,
      emailVerified: record.emailVerified,
      emailVerifiedAt: record.emailVerifiedAt,
      platformSuspendedAt: record.platformSuspendedAt,
      platformSuspendedBy: record.platformSuspendedBy,
      platformSuspendedReason: record.platformSuspendedReason,
      createdAt: record.createdAt,
    });
  }

  async save(account: Account): Promise<void> {
    await this.prisma.account.create({
      data: {
        id: account.id,
        name: account.name,
        email: account.email,
        selectedPlanId: account.selectedPlanId,
        cpf: account.cpf ?? undefined,
        phone: account.phone ?? undefined,
        address: account.address ?? undefined,
        addressNumber: account.addressNumber ?? undefined,
        addressComplement: account.addressComplement ?? undefined,
        addressCity: account.addressCity ?? undefined,
        avatarUrl: account.avatarUrl ?? undefined,
        passwordHash: account.passwordHash,
        role: account.role as ACCOUNT_ROLE_TYPE | undefined,
        emailVerified: account.emailVerified,
        emailVerifiedAt: account.emailVerifiedAt,
        platformSuspendedAt: account.platformSuspendedAt,
        platformSuspendedBy: account.platformSuspendedBy,
        platformSuspendedReason: account.platformSuspendedReason,
        createdAt: account.createdAt,
      },
    });
  }

  async markEmailVerified(account: Account): Promise<void> {
    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        emailVerified: account.emailVerified,
        emailVerifiedAt: account.emailVerifiedAt,
      },
    });
  }

  async updatePassword(accountId: string, passwordHash: string): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { passwordHash },
    });
  }

  async updateAccount(
    accountId: string,
    data: UpdateAccountProps,
  ): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data,
    });
  }

  async attachStripeCustomer(
    accountId: string,
    stripeCustomerId: string,
  ): Promise<void> {
    await this.prisma.account.update({
      where: { id: accountId },
      data: { stripeCustomerId },
    });
  }

  /**
   * Anonimiza a conta. Ver o contrato em `AccountsRepositoryInterface`.
   *
   * A ordem importa: as credenciais saem primeiro, para que nenhuma sessão
   * sobreviva à transação, e a linha da conta é reescrita por último.
   */
  async anonymize(id: string): Promise<void> {
    const anonymizedAt = new Date();

    await this.prisma.$transaction(async (tx) => {
      // ── Credenciais: tudo que permite voltar a entrar ────────────────────
      await tx.session.deleteMany({ where: { accountId: id } });
      await tx.passwordResetToken.deleteMany({ where: { accountId: id } });
      await tx.emailVerificationToken.deleteMany({ where: { accountId: id } });
      await tx.accountProviderIdentity.deleteMany({ where: { accountId: id } });

      // ── Preferências: configuração pessoal, sem valor de registro ────────
      await tx.preference.deleteMany({ where: { accountId: id } });

      // ── Meio de pagamento ────────────────────────────────────────────────
      // O cartão guarda bandeira, seis primeiros, quatro últimos e o nome
      // impresso: é dado pessoal e não compõe documento fiscal, que a Stripe
      // emite e guarda. A assinatura solta a referência antes, senão a FK
      // impede a remoção.
      await tx.subscription.updateMany({
        where: { accountId: id },
        data: { billingCardId: null },
      });
      await tx.billingCard.deleteMany({ where: { accountId: id } });

      // ── O que NÃO sai, e por quê ─────────────────────────────────────────
      // `invoice`, `payment` e `subscription` continuam: são registro fiscal e
      // contratual, com prazo legal de guarda próprio (§7 da Política de
      // Privacidade). A versão anterior deste método os apagava — o que
      // contradizia a própria política e destruía a contabilidade de uma
      // cobrança que a Stripe continua tendo do outro lado. Anonimizada a
      // conta, eles deixam de apontar para uma pessoa identificável.
      //
      // Nada de organização é tocado aqui: anúncios, criativos, métricas,
      // achados, recomendações e a trilha de execução pendem de `Organization`.

      await tx.account.update({
        where: { id },
        data: {
          name: 'Conta excluída',
          // `.invalid` é reservado pela RFC 2606 e não resolve em lugar nenhum,
          // então o endereço não vira caixa de e-mail de ninguém. O id mantém a
          // unicidade da coluna sem reintroduzir o e-mail real.
          email: `deleted-${id}@deleted.invalid`,
          cpf: null,
          phone: null,
          address: null,
          addressNumber: null,
          addressComplement: null,
          addressCity: null,
          avatarUrl: null,
          // Não é um hash: nenhuma senha o produz, e a verificação falha por
          // formato antes de comparar. O acesso já está fechado pelo filtro de
          // `findByEmail`; isto é a tranca de dentro.
          passwordHash: 'account-anonymized',
          // Soltar o cliente Stripe evita que a linha anônima continue sendo um
          // ponteiro para o cadastro completo do outro lado.
          stripeCustomerId: null,
          emailVerified: false,
          emailVerifiedAt: null,
          deletedAt: anonymizedAt,
        },
      });
    });
  }

  async listOwnedOrganizations(id: string): Promise<OwnedOrganization[]> {
    return this.prisma.organization.findMany({
      where: { ownerId: id, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async changePlatformRole(
    accountId: string,
    role: PlatformRole,
  ): Promise<ChangePlatformRoleResult> {
    return this.prisma.$transaction(async (tx) => {
      /**
       * Trava as linhas de administrador **antes** de contar.
       *
       * `FOR UPDATE` serializa duas rebaixas concorrentes: a segunda espera a
       * primeira terminar e então conta o que sobrou. Sem a trava, as duas
       * contariam "dois" sob READ COMMITTED e zerariam a administração.
       */
      const admins = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts
        WHERE role = 'ALLVA_ADMIN' AND deleted_at IS NULL
        FOR UPDATE
      `;

      const current = await tx.account.findUnique({
        where: { id: accountId },
        select: { role: true },
      });

      if (!current) return { outcome: 'UNCHANGED' as const };
      if (current.role === role) return { outcome: 'UNCHANGED' as const };

      const demotesAnAdmin =
        current.role === 'ALLVA_ADMIN' && role !== 'ALLVA_ADMIN';

      if (demotesAnAdmin && admins.length <= 1) {
        return { outcome: 'LAST_ADMIN' as const };
      }

      await tx.account.update({ where: { id: accountId }, data: { role } });

      return {
        outcome: 'UPDATED' as const,
        previousRole: current.role as PlatformRole,
      };
    });
  }

  async changePlatformStatus(
    accountId: string,
    status: PlatformAccountStatus,
    actorId: string,
    reason: string,
  ): Promise<ChangePlatformStatusResult> {
    return this.prisma.$transaction(async (tx) => {
      const admins = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM accounts
        WHERE role = 'ALLVA_ADMIN'
          AND deleted_at IS NULL
          AND platform_suspended_at IS NULL
        FOR UPDATE
      `;

      const current = await tx.account.findUnique({
        where: { id: accountId },
        select: { role: true, platformSuspendedAt: true },
      });

      if (!current) return { outcome: 'UNCHANGED' as const };

      const previousStatus: PlatformAccountStatus = current.platformSuspendedAt
        ? 'DISABLED'
        : 'ACTIVE';

      if (previousStatus === status) return { outcome: 'UNCHANGED' as const };

      const disablesLastAdmin =
        current.role === 'ALLVA_ADMIN' &&
        status === 'DISABLED' &&
        admins.length <= 1;

      if (disablesLastAdmin) return { outcome: 'LAST_ADMIN' as const };

      await tx.account.update({
        where: { id: accountId },
        data:
          status === 'DISABLED'
            ? {
                platformSuspendedAt: new Date(),
                platformSuspendedBy: actorId,
                platformSuspendedReason: reason,
              }
            : {
                platformSuspendedAt: null,
                platformSuspendedBy: null,
                platformSuspendedReason: null,
              },
      });

      if (status === 'DISABLED') {
        await tx.session.updateMany({
          where: { accountId, revokedAt: null },
          data: { revokedAt: new Date(), updatedAt: new Date() },
        });
      }

      return { outcome: 'UPDATED' as const, previousStatus };
    });
  }
}
