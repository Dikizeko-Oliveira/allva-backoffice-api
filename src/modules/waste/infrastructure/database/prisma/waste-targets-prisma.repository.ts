import { Injectable } from '@nestjs/common';
import {
  resolveAdOptimization,
  toOptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import { sweepableAdAccountWhere } from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import {
  DEFAULT_DETECTOR_PROFILE,
  resolveProfile,
  type DetectorProfile,
} from 'src/modules/waste/domain/detector-profile';
import {
  WasteTargetsRepositoryInterface,
  type DetectableAd,
  type DetectionSettings,
} from 'src/modules/waste/domain/ports/waste-targets.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** Entregando: só estes têm gasto futuro a interromper (§10.1). */
const DELIVERING_STATUSES = ['ACTIVE', 'PENDING_REVIEW'];

/** As três colunas do objetivo traduzido, em conjunto e campanha. */
const OPTIMIZATION_SELECT = {
  optimizationClass: true,
  conversionEvent: true,
  conversionMeasurable: true,
} as const;

@Injectable()
export class WasteTargetsPrismaRepository extends WasteTargetsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * A régua da organização, a saúde da conta e a validade da observação numa
   * consulta só.
   *
   * As três viajam juntas porque a decisão de detectar depende das três, e
   * separá-las abriria a janela em que o serviço lê a configuração, decide
   * rodar, e só então descobre que a conta está cega — tendo já lido a série.
   */
  async settingsForAccount(
    adAccountId: string,
  ): Promise<DetectionSettings | null> {
    const account = await this.prisma.adAccount.findUnique({
      where: { id: adAccountId },
      select: {
        accountId: true,
        organizationId: true,
        syncHealth: true,
        lastSuccessfulFullSyncAt: true,
        // A janela de atribuição é **da conta**, não da organização (§8.2):
        // duas contas da mesma organização podem atribuir em 7 e em 28 dias, e
        // é ela que define quanto a janela julgada recua para já ter assentado.
        attributionWindowDays: true,
        organization: {
          select: {
            baseCurrency: true,
            currencyState: true,
            adsSettings: {
              select: {
                scoringWindowDays: true,
                activeDetectorProfileVersion: true,
              },
            },
          },
        },
      },
    });

    if (!account) return null;

    const settings = account.organization?.adsSettings;
    const blockedReason = detectionBlockedReason({
      syncHealth: account.syncHealth,
      currencyState: account.organization?.currencyState ?? 'STABLE',
    });

    return {
      organizationId: account.organizationId,
      accountId: account.accountId,
      baseCurrency: account.organization?.baseCurrency ?? 'BRL',
      // A configuração existe para toda organização desde a correção de dívida
      // que precedeu A2-S4; o fallback usa os defaults do schema, não valores
      // inventados aqui.
      windowDays: settings?.scoringWindowDays ?? 14,
      attributionWindowDays: account.attributionWindowDays,
      activeDetectorProfileVersion:
        settings?.activeDetectorProfileVersion ??
        DEFAULT_DETECTOR_PROFILE.version,
      // §10.7 passo 1: a varredura completa precisa ter acontecido **e** cobrir
      // a janela. `null` significa que nunca houve — e nunca houve não é "está
      // tudo certo", é "não temos como saber".
      hasValidObservation:
        account.lastSuccessfulFullSyncAt !== null &&
        account.syncHealth === 'HEALTHY',
      detectionAllowed: blockedReason === null,
      detectionBlockedReason: blockedReason,
      lastSuccessfulFullSyncAt: account.lastSuccessfulFullSyncAt,
    };
  }

  async profileFor(
    organizationId: string,
    version: string,
  ): Promise<DetectorProfile> {
    // Perfil da organização primeiro, padrão global depois. Uma organização que
    // calibrou um limiar não pode perder os outros nove — `resolveProfile` faz o
    // merge por chave sobre o padrão.
    const profile =
      (await this.prisma.detectorProfile.findFirst({
        where: { version, organizationId },
      })) ??
      (await this.prisma.detectorProfile.findFirst({
        where: { version, organizationId: null },
      }));

    if (!profile) return DEFAULT_DETECTOR_PROFILE;

    return resolveProfile({
      version: profile.version,
      organizationId: profile.organizationId,
      thresholds: profile.thresholds,
      provenance: profile.provenance,
      effectiveFrom: profile.effectiveFrom,
    });
  }

  async listDetectable(adAccountId: string): Promise<DetectableAd[]> {
    const rows = await this.prisma.ad.findMany({
      // Arquivados entram: é a passagem deles por aqui que fecha item aberto
      // como `STALE`. Filtrá-los deixaria o achado pendurado para sempre num
      // anúncio que não existe mais na plataforma.
      //
      // **E é por isso que a régua de plano é um `OR`, não um `AND`.** A seleção
      // de 05:00 só carimba anúncio vivo, então filtrar por elegibilidade sozinha
      // varreria todo arquivado para fora — e cada achado aberto sobre um anúncio
      // arquivado ficaria pendurado exatamente como o comentário acima descreve,
      // agora por outro caminho. O teto governa o que se **analisa**; encerrar o
      // que já não existe não é análise.
      where: {
        adAccountId,
        OR: [
          { analysisEligibleAt: { not: null } },
          { archivedAt: { not: null } },
        ],
      },
      select: {
        id: true,
        accountId: true,
        adSetId: true,
        campaignId: true,
        adAccountId: true,
        platform: true,
        unitKind: true,
        creativeId: true,
        observedStatus: true,
        archivedAt: true,
        dataMaturity: true,
        adAccount: { select: { currency: true } },
        creative: { select: { contentHash: true } },
        adSet: { select: OPTIMIZATION_SELECT },
        campaign: { select: OPTIMIZATION_SELECT },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      accountId: row.accountId,
      adSetId: row.adSetId,
      campaignId: row.campaignId,
      adAccountId: row.adAccountId,
      platform: row.platform,
      unitKind: row.unitKind,
      creativeId: row.creativeId,
      contentHash: row.creative?.contentHash ?? null,
      isDelivering:
        row.archivedAt === null &&
        DELIVERING_STATUSES.includes(row.observedStatus),
      // O conjunto primeiro, a campanha depois: é onde Meta e TikTok decidem a
      // otimização, e o Google replica a da campanha no grupo.
      optimization: resolveAdOptimization(
        row.adSet ? toOptimizationTarget(row.adSet) : null,
        toOptimizationTarget(row.campaign),
      ),
      archivedAt: row.archivedAt,
      currency: row.adAccount.currency,
      dataMaturity: row.dataMaturity,
    }));
  }

  async listAccountsToDetect(): Promise<
    Array<{ adAccountId: string; organizationId: string }>
  > {
    // Só conta que o sync ainda lê — credencial viva, organização que existe,
    // não congelada. As outras nunca teriam `ad-scoring` na janela e
    // terminariam `SKIPPED`, depois de enfileirar e gravar `job_runs` todo dia.
    //
    // Contas cegas continuam na lista: credencial viva com leitura incompleta é
    // degradação, e o job as visita, registra a pausa e segue. Filtrá-las faria
    // a degradação sumir do painel operacional exatamente quando ela é a
    // informação mais útil.
    const rows = await this.prisma.adAccount.findMany({
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
 * A tabela de degradação de §8.7, na linha da detecção.
 *
 * `DEGRADED` pausa: a leitura está incompleta, e detectar sobre ela produz
 * achado em anúncio que ninguém tocou — pior, produz auto-resolve em achado que
 * continua verdadeiro. `RECOMPUTING_CURRENCY` também pausa, porque metade da
 * base está numa unidade e metade na outra.
 */
function detectionBlockedReason(input: {
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
