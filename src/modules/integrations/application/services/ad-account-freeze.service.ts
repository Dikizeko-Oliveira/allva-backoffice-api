import { Injectable, Logger } from '@nestjs/common';
import { PlanType } from 'src/modules/organizations/domain/plan-seat-limits';
import {
  planAllowList,
  planQuota,
} from 'src/modules/plans/domain/plan-entitlements';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

/** A janela sobre a qual o gasto ordena quem fica. */
const RANKING_WINDOW_DAYS = 30;

export type FreezeCandidate = {
  adAccountId: string;
  name: string;
  platform: string;
  spendBase: number;
  /**
   * `PLATFORM` não é escolha: o plano de destino não inclui a plataforma, e
   * nenhuma seleção do usuário salva esta conta.
   */
  forcedBy: 'PLATFORM' | null;
};

export type FreezePreview = {
  targetPlanType: PlanType;
  effectiveAt: Date | null;
  /** Quantas contas o plano de destino permite. `null` é ilimitado. */
  quota: number | null;
  allowedPlatforms: readonly string[];
  /** Congelam de qualquer forma — plataforma fora do plano. */
  forced: FreezeCandidate[];
  /** Entre estas o usuário escolhe quais ficam. */
  selectable: FreezeCandidate[];
  /** As que ficarão ativas se nada for escolhido, ou conforme a escolha atual. */
  keeping: string[];
  freezing: string[];
};

/**
 * Quem fica ativo quando o plano encolhe.
 *
 * ## Congelar, não desvincular
 *
 * Desvincular perde o vínculo e obriga a reconectar; congelar preserva conta,
 * histórico e identidade, e o upgrade desfaz. São estados diferentes em colunas
 * diferentes (`integrationId` e `frozenAt`) justamente para que subir de plano
 * descongele o que o plano congelou **sem** reativar o que o usuário desligou.
 *
 * ## A data é futura, e a leitura decide
 *
 * O downgrade só vale no fim do período pago — o cliente comprou o mês inteiro.
 * Então o carimbo é `pendingPlanEffectiveAt`, e "congelada" é `frozenAt <= now`,
 * avaliado na leitura. É o mesmo desenho da expiração do teste, e pela mesma
 * razão: **o único que aplicaria o plano é o webhook da Stripe**, e um
 * congelamento que dependesse dele não aconteceria se ele falhasse.
 *
 * ## A ordem do default
 *
 * Quem não escolhe fica com as contas que **mais gastam** — a mesma régua do
 * teto de anúncios analisados. Uma regra só para as duas coisas, e é a que se
 * defende num ticket: a Allva continuou olhando onde está o dinheiro.
 */
@Injectable()
export class AdAccountFreezeService {
  private readonly logger = new Logger(AdAccountFreezeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * O que vai acontecer, sem mudar nada — é o que a tela mostra antes de o
   * usuário decidir.
   */
  async preview(input: {
    organizationId: string;
    targetPlanType: PlanType;
    effectiveAt: Date | null;
    /** Escolha do usuário; ausente usa o default por gasto. */
    keepActiveAdAccountIds?: string[];
  }): Promise<FreezePreview> {
    const quota = this.quotaFor(input.targetPlanType);
    const allowedPlatforms =
      planAllowList(input.targetPlanType, 'platforms') ?? [];
    const candidates = await this.candidatesFor(input.organizationId);

    const forced = candidates.filter(
      (candidate) => !allowedPlatforms.includes(candidate.platform),
    );
    const selectable = candidates.filter(
      (candidate) => !forced.includes(candidate),
    );

    const keeping = this.resolveKeeping({
      selectable,
      quota,
      chosen: input.keepActiveAdAccountIds,
    });

    const keepingSet = new Set(keeping);

    return {
      targetPlanType: input.targetPlanType,
      effectiveAt: input.effectiveAt,
      quota,
      allowedPlatforms,
      forced: forced.map((candidate) => ({
        ...candidate,
        forcedBy: 'PLATFORM',
      })),
      selectable,
      keeping,
      freezing: candidates
        .filter((candidate) => !keepingSet.has(candidate.adAccountId))
        .map((candidate) => candidate.adAccountId),
    };
  }

  /** Carimba a decisão. `effectiveAt` no futuro é agendamento. */
  async apply(input: {
    organizationId: string;
    targetPlanType: PlanType;
    effectiveAt: Date;
    keepActiveAdAccountIds?: string[];
  }): Promise<FreezePreview> {
    const preview = await this.preview(input);

    await this.prisma.$transaction([
      this.prisma.adAccount.updateMany({
        where: {
          organizationId: input.organizationId,
          id: { in: preview.freezing },
        },
        data: { frozenAt: input.effectiveAt },
      }),
      // Quem fica não pode carregar congelamento de uma decisão anterior: o
      // usuário pode trocar a seleção quantas vezes quiser dentro da janela.
      this.prisma.adAccount.updateMany({
        where: {
          organizationId: input.organizationId,
          id: { in: preview.keeping },
        },
        data: { frozenAt: null },
      }),
    ]);

    this.logger.log(
      `ad_account_freeze.scheduled organizacao=${input.organizationId} ` +
        `plano=${input.targetPlanType} mantidas=${preview.keeping.length} ` +
        `congeladas=${preview.freezing.length} em=${input.effectiveAt.toISOString()}`,
    );

    return preview;
  }

  /**
   * Descongela tudo — o caminho do upgrade.
   *
   * Limpa o agendado **e** o já aplicado: subir de plano restaura o que havia.
   * Conta que o usuário desvinculou não volta, porque desvincular é
   * `integrationId = null` e nada aqui toca nisso.
   */
  async thawAll(organizationId: string): Promise<number> {
    const { count } = await this.prisma.adAccount.updateMany({
      where: { organizationId, frozenAt: { not: null } },
      data: { frozenAt: null },
    });

    if (count > 0) {
      this.logger.log(
        `ad_account_freeze.thawed organizacao=${organizationId} contas=${count}`,
      );
    }

    return count;
  }

  /**
   * Valida a escolha do usuário antes de aplicá-la.
   *
   * Recusar uma conta de plataforma fora do plano é o ponto: sem isso, a tela
   * deixaria o usuário "salvar" uma conta TikTok num plano sem TikTok, e o
   * sistema a congelaria mesmo assim — a pior forma de dizer não, que é dizer
   * sim e não cumprir.
   */
  assertSelectionIsValid(
    preview: FreezePreview,
    keepActiveAdAccountIds: string[],
  ): void {
    const selectable = new Set(
      preview.selectable.map((candidate) => candidate.adAccountId),
    );

    const invalid = keepActiveAdAccountIds.filter((id) => !selectable.has(id));

    if (invalid.length > 0) {
      throw new DomainError({
        code: 'AD_ACCOUNT_NOT_SELECTABLE',
        category: 'PLAN_LIMITED',
        message:
          'Uma ou mais contas não podem ficar ativas no plano escolhido: a ' +
          'plataforma delas não está incluída.',
        details: { adAccountIds: invalid },
      });
    }

    if (
      preview.quota !== null &&
      keepActiveAdAccountIds.length > preview.quota
    ) {
      throw new DomainError({
        code: 'AD_ACCOUNT_SELECTION_EXCEEDS_QUOTA',
        category: 'PLAN_LIMITED',
        message: `O plano escolhido permite ${preview.quota} contas ativas, e foram selecionadas ${keepActiveAdAccountIds.length}.`,
        details: {
          quota: preview.quota,
          selected: keepActiveAdAccountIds.length,
        },
      });
    }
  }

  private quotaFor(planType: PlanType): number | null {
    const quota = planQuota(planType, 'ad-accounts');
    return quota === undefined ? null : quota;
  }

  /**
   * As contas vinculadas da organização, ordenadas por gasto na janela.
   *
   * `LEFT JOIN`: conta recém-vinculada ainda não tem série, e um `INNER JOIN` a
   * excluiria do ranking — ela sumiria da lista em vez de disputar a vaga por
   * baixo, que é onde deve disputar.
   */
  private async candidatesFor(
    organizationId: string,
  ): Promise<FreezeCandidate[]> {
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - RANKING_WINDOW_DAYS);

    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; name: string; platform: string; spend_base: number }>
    >`
      SELECT a."id", a."name", a."platform"::text AS platform,
             COALESCE(m.spend_base, 0)::float8 AS spend_base
      FROM "ad_accounts" a
      LEFT JOIN (
        SELECT s."ad_account_id", SUM(s."spend_base") AS spend_base
        FROM "ad_metric_snapshots" s
        WHERE s."organization_id" = ${organizationId}
          AND s."date" >= ${since}::date
        GROUP BY s."ad_account_id"
      ) m ON m."ad_account_id" = a."id"
      WHERE a."organization_id" = ${organizationId}
        AND a."integration_id" IS NOT NULL
      ORDER BY COALESCE(m.spend_base, 0) DESC, a."id" ASC
    `;

    return rows.map((row) => ({
      adAccountId: row.id,
      name: row.name,
      platform: row.platform,
      spendBase: Number(row.spend_base),
      forcedBy: null,
    }));
  }

  /**
   * Quem fica: a escolha do usuário, ou o topo do ranking.
   *
   * A escolha ainda é cortada pelo teto — validá-la é responsabilidade de
   * `assertSelectionIsValid`, mas o preview precisa devolver um resultado
   * coerente mesmo quando chamado com uma escolha inválida, senão a tela
   * mostraria mais contas ativas do que o plano permite.
   */
  private resolveKeeping(input: {
    selectable: FreezeCandidate[];
    quota: number | null;
    chosen?: string[];
  }): string[] {
    const ranked = input.selectable.map((candidate) => candidate.adAccountId);

    if (input.quota === null) return ranked;

    if (input.chosen && input.chosen.length > 0) {
      const chosen = new Set(input.chosen);
      return ranked.filter((id) => chosen.has(id)).slice(0, input.quota);
    }

    return ranked.slice(0, input.quota);
  }
}
