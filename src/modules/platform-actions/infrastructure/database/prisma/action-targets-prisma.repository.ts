import { Injectable } from '@nestjs/common';
import type { ActionLevel } from 'src/modules/ads/domain/platform/platform-profile';
import {
  ActionTargetView,
  ActionTargetsRepositoryInterface,
  InFlightWrite,
} from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class ActionTargetsPrismaRepository extends ActionTargetsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findTarget(input: {
    organizationId: string;
    adId: string;
  }): Promise<ActionTargetView | null> {
    const ad = await this.prisma.ad.findFirst({
      /**
       * `organizationId` no `where`, não conferido depois (§16.7). A diferença
       * aparece sob concorrência e sob bug: uma consulta por id que valida a
       * organização em memória já leu a linha de outro tenant, e basta um
       * `return` esquecido para ela vazar.
       */
      where: { id: input.adId, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        accountId: true,
        platform: true,
        externalAdId: true,
        unitKind: true,
        observedStatus: true,
        desiredStatus: true,
        syncState: true,
        version: true,
        adAccount: {
          select: {
            id: true,
            currency: true,
            externalAccountId: true,
            integrationId: true,
            organization: { select: { actionsEnabled: true } },
          },
        },
        adSet: { select: { id: true, externalAdSetId: true } },
        campaign: { select: { id: true, externalCampaignId: true } },
        creative: { select: { format: true } },
      },
    });

    if (!ad) return null;

    /**
     * Conta sem integração corrente é conta desconectada (P10), e o alvo **volta
     * mesmo assim** com `integrationId: null`.
     *
     * Descartá-lo aqui fazia as três rotas de escrita responderem `404 Anúncio
     * não encontrado` sobre um anúncio que existe, está na organização e aparece
     * em todas as outras telas - o usuário lia "sumiu" onde o fato era
     * "reconecte a integração". Quem precisa da credencial recusa com o motivo
     * certo; quem só declara capacidade (§13.3) agora consegue declará-la.
     */
    return {
      adId: ad.id,
      organizationId: ad.organizationId,
      accountId: ad.accountId,
      platform: ad.platform,
      adAccountId: ad.adAccount.id,
      integrationId: ad.adAccount.integrationId,
      accountCurrency: ad.adAccount.currency,
      externalAccountId: ad.adAccount.externalAccountId,
      externalAdId: ad.externalAdId,
      unitKind: ad.unitKind,
      creativeFormat: ad.creative?.format ?? null,
      observedStatus: ad.observedStatus,
      desiredStatus: ad.desiredStatus,
      syncState: ad.syncState,
      version: ad.version,
      adSet: ad.adSet
        ? { id: ad.adSet.id, externalId: ad.adSet.externalAdSetId }
        : null,
      campaign: {
        id: ad.campaign.id,
        externalId: ad.campaign.externalCampaignId,
      },
      actionsEnabled: ad.adAccount.organization.actionsEnabled,
    };
  }

  async findInFlightWrites(input: {
    organizationId: string;
    targets: Array<{ type: ActionLevel; id: string }>;
  }): Promise<InFlightWrite[]> {
    if (input.targets.length === 0) return [];

    const rows = await this.prisma.actionExecution.findMany({
      where: {
        organizationId: input.organizationId,
        /**
         * O mesmo predicado do índice parcial `action_executions_inflight_unique`.
         * Divergir dele aqui produziria uma tela que oferece o botão e um banco
         * que recusa a linha — o pior par possível, porque o usuário já clicou.
         */
        status: { in: ['QUEUED', 'RUNNING'] },
        OR: input.targets.map((target) => ({
          targetEntityType: target.type,
          targetEntityId: target.id,
        })),
      },
      select: { id: true, targetEntityType: true, targetEntityId: true },
    });

    return rows.map((row) => ({
      executionId: row.id,
      targetEntityType: row.targetEntityType as ActionLevel,
      targetEntityId: row.targetEntityId,
    }));
  }
}
