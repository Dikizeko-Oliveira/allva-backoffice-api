import { Injectable } from '@nestjs/common';
import {
  OrganizationAdsSettings,
  OrganizationAdsSettingsPortInterface,
} from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** O default do schema, repetido aqui só como última rede - veja `find`. */
const SCHEMA_DEFAULT_WINDOW_DAYS = 14;

@Injectable()
export class OrganizationAdsSettingsPrismaRepository implements OrganizationAdsSettingsPortInterface {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A linha de `organization_ads_settings` existe para toda organização desde a
   * correção de dívida que precedeu A2-S4 - o repositório de organizações a
   * grava na mesma transação da criação. O fallback é a última rede, e usa o
   * default do schema em vez de um número inventado aqui, pela mesma razão que
   * `WasteSettingsPrismaReader` documenta.
   */
  async find(organizationId: string): Promise<OrganizationAdsSettings> {
    const row = await this.prisma.organizationAdsSettings.findUnique({
      where: { organizationId },
      select: { scoringWindowDays: true },
    });

    return {
      organizationId,
      scoringWindowDays: row?.scoringWindowDays ?? SCHEMA_DEFAULT_WINDOW_DAYS,
    };
  }

  /**
   * `upsert` e não `update`: a organização cuja linha faltar por qualquer razão
   * ganharia um 500 na hora de salvar uma configuração que a tela mostrou como
   * editável.
   */
  async updateScoringWindowDays(
    organizationId: string,
    scoringWindowDays: number,
  ): Promise<OrganizationAdsSettings> {
    const row = await this.prisma.organizationAdsSettings.upsert({
      where: { organizationId },
      update: { scoringWindowDays },
      create: { organizationId, scoringWindowDays },
      select: { scoringWindowDays: true },
    });

    return { organizationId, scoringWindowDays: row.scoringWindowDays };
  }

  async findLlmDailyBudget(organizationId: string): Promise<number | null> {
    const row = await this.prisma.organizationAdsSettings.findUnique({
      where: { organizationId },
      select: { llmDailyBudgetBase: true },
    });

    /**
     * Sem linha devolve `null`, que significa **sem teto** — e aqui isso é a
     * resposta honesta, não uma falha aberta. A linha existe para toda
     * organização desde a correção que precedeu A2-S4; se faltar, inventar 50
     * afirmaria um teto que o banco não tem, e a leitura discordaria da guarda
     * que lê a mesma coluna.
     */
    return row?.llmDailyBudgetBase === null ||
      row?.llmDailyBudgetBase === undefined
      ? null
      : Number(row.llmDailyBudgetBase);
  }

  async updateLlmDailyBudget(
    organizationId: string,
    llmDailyBudgetBase: number | null,
  ): Promise<number | null> {
    const row = await this.prisma.organizationAdsSettings.upsert({
      where: { organizationId },
      update: { llmDailyBudgetBase },
      create: { organizationId, llmDailyBudgetBase },
      select: { llmDailyBudgetBase: true },
    });

    return row.llmDailyBudgetBase === null
      ? null
      : Number(row.llmDailyBudgetBase);
  }
}
