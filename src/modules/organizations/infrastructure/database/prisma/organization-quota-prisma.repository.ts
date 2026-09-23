import { Injectable } from '@nestjs/common';
import {
  NO_QUOTA_OVERRIDES,
  OrganizationQuotaOverrides,
  OrganizationQuotaPatch,
  OrganizationQuotaPortInterface,
} from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class OrganizationQuotaPrismaRepository implements OrganizationQuotaPortInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Organização sem linha na tabela não tem teto negociado — cai no do plano.
   *
   * É o caso da esmagadora maioria: só contrato Enterprise grava aqui. Por isso
   * a ausência devolve `NO_QUOTA_OVERRIDES` em vez de `null`: quem chama não
   * precisa distinguir "sem linha" de "linha com tudo vazio", e as duas dizem a
   * mesma coisa.
   */
  async findOverrides(
    organizationId: string,
  ): Promise<OrganizationQuotaOverrides> {
    const row = await this.prisma.organizationQuota.findUnique({
      where: { organizationId },
      select: {
        maxAdAccounts: true,
        maxMonitoredAds: true,
        maxSeats: true,
        maxOrganizations: true,
        maxCopyGenerationsMonthly: true,
        maxCreativeAnalysesMonthly: true,
      },
    });

    if (!row) return NO_QUOTA_OVERRIDES;

    return {
      adAccounts: row.maxAdAccounts,
      monitoredAds: row.maxMonitoredAds,
      seats: row.maxSeats,
      organizations: row.maxOrganizations,
      copyGenerations: row.maxCopyGenerationsMonthly,
      creativeAnalyses: row.maxCreativeAnalysesMonthly,
    };
  }

  async upsertOverrides(
    organizationId: string,
    patch: OrganizationQuotaPatch,
  ): Promise<OrganizationQuotaOverrides> {
    /**
     * Só as chaves presentes viram colunas no `data`.
     *
     * `undefined` no Prisma já significa "não altere", mas montar o objeto a
     * partir do que veio é o que garante isso mesmo se alguém passar o patch
     * inteiro com campos ausentes — e deixa o `null` (limpar) explícito.
     */
    const data = {
      ...(patch.adAccounts !== undefined
        ? { maxAdAccounts: patch.adAccounts }
        : {}),
      ...(patch.monitoredAds !== undefined
        ? { maxMonitoredAds: patch.monitoredAds }
        : {}),
      ...(patch.seats !== undefined ? { maxSeats: patch.seats } : {}),
      ...(patch.organizations !== undefined
        ? { maxOrganizations: patch.organizations }
        : {}),
      ...(patch.copyGenerations !== undefined
        ? { maxCopyGenerationsMonthly: patch.copyGenerations }
        : {}),
      ...(patch.creativeAnalyses !== undefined
        ? { maxCreativeAnalysesMonthly: patch.creativeAnalyses }
        : {}),
    };

    const row = await this.prisma.organizationQuota.upsert({
      where: { organizationId },
      update: data,
      create: { organizationId, ...data },
    });

    return {
      adAccounts: row.maxAdAccounts,
      monitoredAds: row.maxMonitoredAds,
      seats: row.maxSeats,
      organizations: row.maxOrganizations,
      copyGenerations: row.maxCopyGenerationsMonthly,
      creativeAnalyses: row.maxCreativeAnalysesMonthly,
    };
  }
}
