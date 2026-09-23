import { Injectable } from '@nestjs/common';
import {
  resolveAdOptimization,
  toOptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import {
  AdScoringTargetsRepositoryInterface,
  ScorableAd,
  ScoringSettings,
} from 'src/modules/ad-scoring/domain/ports/ad-scoring-targets.repository';
import { sweepableAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * §12.5 — "scoring roda apenas para anúncios **ativos com dados na janela**".
 *
 * Pausado e arquivado entram na lista mesmo assim, e são congelados: pular faria
 * o último score envelhecer sem nunca declarar que parou de valer, e a tela
 * mostraria um número de duas semanas atrás como se fosse de hoje.
 */
const DELIVERING_STATUSES = ['ACTIVE', 'PENDING_REVIEW'];

const OPTIMIZATION_SELECT = {
  optimizationClass: true,
  conversionEvent: true,
  conversionMeasurable: true,
} as const;

@Injectable()
export class AdScoringTargetsPrismaRepository extends AdScoringTargetsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listScorable(adAccountId: string): Promise<ScorableAd[]> {
    const rows = await this.prisma.ad.findMany({
      /**
       * `analysisEligibleAt` é a régua de plano da noite, decidida às 05:00 por
       * `AnalysisScopeService`. Ordenar e cortar aqui daria a este motor um
       * conjunto próprio, e o detector — que roda meia hora depois, sobre um
       * gasto já reescrito pelo ingest — teria outro.
       */
      where: {
        adAccountId,
        archivedAt: null,
        analysisEligibleAt: { not: null },
      },
      select: {
        id: true,
        lineageId: true,
        name: true,
        platform: true,
        adSetId: true,
        campaignId: true,
        creativeId: true,
        observedStatus: true,
        adSet: { select: OPTIMIZATION_SELECT },
        campaign: { select: OPTIMIZATION_SELECT },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      lineageId: row.lineageId,
      name: row.name,
      platform: row.platform,
      adSetId: row.adSetId,
      campaignId: row.campaignId,
      creativeId: row.creativeId,
      optimization: resolveAdOptimization(
        row.adSet ? toOptimizationTarget(row.adSet) : null,
        toOptimizationTarget(row.campaign),
      ),
      isDelivering: DELIVERING_STATUSES.includes(row.observedStatus),
    }));
  }

  /**
   * A régua da organização **e** o veredito de §8.7 numa consulta só.
   *
   * As duas coisas viajam juntas porque a decisão de pontuar depende das duas, e
   * separá-las abriria a janela em que o serviço lê a configuração, decide
   * rodar, e só então descobre que a conta está cega.
   */
  async settingsForAccount(
    adAccountId: string,
  ): Promise<ScoringSettings | null> {
    const account = await this.prisma.adAccount.findUnique({
      where: { id: adAccountId },
      select: {
        organizationId: true,
        syncHealth: true,
        organization: {
          select: {
            currencyState: true,
            adsSettings: {
              select: { scoringWindowDays: true, activeAlgoVersion: true },
            },
          },
        },
      },
    });

    if (!account) return null;

    const settings = account.organization?.adsSettings;
    const blockedReason = scoringBlockedReason({
      syncHealth: account.syncHealth,
      currencyState: account.organization?.currencyState ?? 'STABLE',
    });

    return {
      organizationId: account.organizationId,
      // A configuração existe para toda organização desde a correção de dívida
      // que precedeu A2-S4; o fallback é a última rede e usa os defaults do
      // schema, não valores inventados aqui.
      scoringWindowDays: settings?.scoringWindowDays ?? 14,
      activeAlgoVersion: settings?.activeAlgoVersion ?? 'deterministic-v2.2',
      scoringAllowed: blockedReason === null,
      scoringBlockedReason: blockedReason,
    };
  }

  async listAccountsToScore(): Promise<
    Array<{ adAccountId: string; organizationId: string }>
  > {
    const rows = await this.prisma.adAccount.findMany({
      /**
       * Só conta que o sync ainda lê: credencial viva, organização que existe,
       * não congelada. As outras nunca teriam `ads-ingest-full` na janela e
       * terminariam `SKIPPED` — mas depois de enfileirar, adquirir lease e
       * gravar `job_runs`, todo dia, indefinidamente.
       *
       * Contas **cegas** continuam na lista: credencial viva com leitura
       * incompleta é degradação, e o job as visita, registra a pausa e segue.
       * Filtrá-las faria a degradação sumir do painel operacional exatamente
       * quando ela é a informação mais útil.
       */
      where: sweepableAdAccountWhere(new Date()),
      select: { id: true, organizationId: true },
      orderBy: { discoveredAt: 'asc' },
    });

    return rows.map((row) => ({
      adAccountId: row.id,
      organizationId: row.organizationId,
    }));
  }
}

/**
 * A tabela de degradação de §8.7, na linha do scoring.
 *
 * `DEGRADED` **pausa** o scoring embora permita ações: a leitura está incompleta,
 * e pontuar sobre ela produziria queda de score em anúncios que ninguém tocou.
 * `RECOMPUTING_CURRENCY` também pausa — a moeda-base está sendo reescrita, e um
 * score calculado no meio da migração compara valores em duas unidades.
 */
function scoringBlockedReason(input: {
  syncHealth: string;
  currencyState: string;
}): string | null {
  if (input.syncHealth === 'UNREACHABLE') return 'ACCOUNT_UNREACHABLE';
  if (input.syncHealth === 'DEGRADED') return 'ACCOUNT_DEGRADED';
  if (input.currencyState === 'RECOMPUTING_CURRENCY') {
    return 'CURRENCY_RECOMPUTING';
  }
  return null;
}
