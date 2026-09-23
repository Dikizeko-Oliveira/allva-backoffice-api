import { Injectable } from '@nestjs/common';
import {
  Organization,
  OrganizationSubscription,
  OrganizationUser,
} from 'src/modules/organizations/domain/entities';
import { OrganizationsRepositoryInterface } from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class OrganizationsPrismaRepository implements OrganizationsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cria a organização, a sua configuração de ads, a participação OWNER **e** a
   * assinatura que declara o plano, na mesma transação.
   *
   * A linha de `organization_ads_settings` (D16/A10) carrega a régua com que a
   * mídia da organização é medida: `activeAlgoVersion`,
   * `activeDetectorProfileVersion`, `scoringWindowDays`, `llmDailyBudgetBase`,
   * `actionDailyCap`. Uma organização sem ela obrigaria o scoring de A2-S4 a
   * inventar um default no código — que é exatamente o que D16 recusou — ou a
   * pulá-la em silêncio.
   *
   * **Por que aqui e não no use case.** São três os caminhos que criam
   * organização (este, o provisionamento de lead e o do cadastro) e o quarto é
   * questão de tempo. Escrever nos use cases deixa a invariante dependendo de
   * alguém lembrar; escrever no único ponto que persiste uma organização nova
   * faz o caminho futuro nascer correto. A atomicidade é o mesmo argumento do
   * provisionamento, que grava seis tabelas numa transação: uma organização pela
   * metade não deve chegar a existir.
   *
   * **A participação entrou depois, pela mesma razão.** Ela estava fora, no use
   * case, como segunda escrita solta: uma falha entre as duas produzia
   * organização sem dono — que é o `membershipId: null` que
   * `CurrentOrganizationResolver` documenta ter encontrado em dado legado.
   *
   * **E a assinatura entrou por último, pela terceira vez que a mesma coisa
   * aconteceu.** Só o provisionamento de lead a gravava, inline; organização de
   * cadastro e de `POST /organizations` nasciam sem plano, e
   * `findPlanTypeByOrganizationId` devolvia nulo para elas. Como `planAllows`
   * fecha na dúvida, o produto negava dezesseis capacidades a clientes que as
   * tinham — vincular conta de anúncios da Meta recusava com
   * `PLAN_FEATURE_NOT_INCLUDED`, nomeando um plano "atual" que ele não conseguia
   * ler.
   */
  async saveWithOwner(
    organization: Organization,
    owner: OrganizationUser,
    subscription: OrganizationSubscription,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.organization.create({
        data: {
          id: organization.id,
          ownerId: organization.ownerId,
          name: organization.name,
          cnpj: organization.cnpj,
          phone: organization.phone,
          address: organization.address,
          addressNumber: organization.addressNumber,
          addressComplement: organization.addressComplement,
          addressCity: organization.addressCity,
          createdAt: organization.createdAt,
          nameConfirmedAt: organization.nameConfirmedAt,
        },
      });

      // Sem valores: os padrões são declarados na tabela. Escrevê-los aqui
      // reintroduziria a constante de código num lugar mais difícil de achar.
      await tx.organizationAdsSettings.create({
        data: { organizationId: organization.id },
      });

      await tx.organizationUser.create({
        data: {
          id: owner.id,
          organizationId: owner.organizationId,
          accountId: owner.accountId,
          role: owner.role,
          status: owner.status,
          frozenAt: owner.frozenAt,
          createdAt: owner.createdAt,
          updatedAt: owner.updatedAt,
          deletedAt: owner.deletedAt,
        },
      });

      // A quarta perna. `findPlanTypeByOrganizationId` lê exatamente esta linha,
      // e é dela que dependem as dezesseis guardas de `ENFORCED_FEATURE_KEYS`:
      // sem ela o plano resolve para nulo e `planAllows` fecha na dúvida — o que
      // é a decisão certa diante de uma dúvida real, e desastroso quando a
      // dúvida é o próprio produto não ter escrito o plano.
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
    });
  }

  async update(organization: Organization): Promise<void> {
    await this.prisma.organization.update({
      where: { id: organization.id },
      data: {
        name: organization.name,
        cnpj: organization.cnpj,
        phone: organization.phone,
        address: organization.address,
        addressNumber: organization.addressNumber,
        addressComplement: organization.addressComplement,
        addressCity: organization.addressCity,
        deletedAt: organization.deletedAt,
        nameConfirmedAt: organization.nameConfirmedAt,
      },
    });
  }

  private toDomain(record: {
    id: string;
    ownerId: string;
    name: string;
    cnpj: string | null;
    phone: string | null;
    address: string | null;
    addressNumber: string | null;
    addressComplement: string | null;
    addressCity: string | null;
    createdAt: Date;
    deletedAt: Date | null;
    nameConfirmedAt: Date | null;
  }): Organization {
    return Organization.restore({
      id: record.id,
      ownerId: record.ownerId,
      name: record.name,
      cnpj: record.cnpj ?? undefined,
      phone: record.phone ?? undefined,
      address: record.address ?? undefined,
      addressNumber: record.addressNumber ?? undefined,
      addressComplement: record.addressComplement ?? undefined,
      addressCity: record.addressCity ?? undefined,
      createdAt: record.createdAt,
      deletedAt: record.deletedAt,
      nameConfirmedAt: record.nameConfirmedAt,
    });
  }

  async findById(id: string): Promise<Organization | null> {
    // Soft-deleted organizations are treated as non-existent.
    const record = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });

    return record ? this.toDomain(record) : null;
  }

  async findByOwnerId(ownerId: string): Promise<Organization | null> {
    const record = await this.prisma.organization.findFirst({
      where: { ownerId, deletedAt: null },
      // Ordem explícita: sem ela, qual organização é "a" da conta passaria a
      // depender do plano de execução do Postgres assim que a segunda existisse.
      orderBy: { createdAt: 'asc' },
    });

    return record ? this.toDomain(record) : null;
  }

  async listByOwnerId(ownerId: string): Promise<Organization[]> {
    const records = await this.prisma.organization.findMany({
      where: { ownerId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return records.map((record) => this.toDomain(record));
  }

  async countByOwnerId(ownerId: string): Promise<number> {
    // A apagada não ocupa vaga: soft delete existe para o dado sobreviver à
    // remoção, não para o teto do plano.
    return this.prisma.organization.count({
      where: { ownerId, deletedAt: null },
    });
  }

  async listByIds(ids: string[]): Promise<Organization[]> {
    if (ids.length === 0) {
      return [];
    }

    // Soft-deleted organizations are treated as non-existent.
    const records = await this.prisma.organization.findMany({
      where: { id: { in: ids }, deletedAt: null },
    });

    return records.map((record) => this.toDomain(record));
  }
}
