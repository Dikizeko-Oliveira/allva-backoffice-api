import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import { moneyView } from 'src/shared/domain/money';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import {
  fromPrismaJsonObject,
  toPrismaJson,
} from 'src/shared/infrastructure/database/prisma/json';
import { parseActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import {
  requiresRecreate,
  type AdActionType,
  type ImpactType,
  type OutcomeDeltaKind,
  type RecommendationKind,
  type RecommendationPriority,
  type RecommendationStatus,
} from 'src/modules/recommendations/domain/contracts/recommendation-catalog';
import type { LifecycleCandidate } from 'src/modules/recommendations/domain/lifecycle';
import type { PremiseState } from 'src/modules/recommendations/domain/premise';
import type { PreWindowSnapshot } from 'src/modules/recommendations/domain/ports/recommendation-outcomes.repository';
import {
  RecommendationsRepositoryInterface,
  type ImpactSummary,
  type PersistPlanInput,
  type PersistedRecommendation,
  type RecommendationListQuery,
  type RecommendationView,
} from 'src/modules/recommendations/domain/ports/recommendations.repository';

const VIEW_INCLUDE = {
  ad: {
    select: {
      id: true,
      lineageId: true,
      name: true,
      platform: true,
      externalAdId: true,
      observedStatus: true,
      dataMaturity: true,
      campaign: { select: { id: true, name: true } },
      adSet: { select: { id: true, name: true } },
    },
  },
  actions: true,
  wasteItems: { include: { wasteItem: true } },
  outcome: true,
} satisfies Prisma.RecommendationInclude;

type ViewRow = Prisma.RecommendationGetPayload<{
  include: typeof VIEW_INCLUDE;
}>;

@Injectable()
export class RecommendationsPrismaRepository extends RecommendationsRepositoryInterface {
  private readonly logger = new Logger(RecommendationsPrismaRepository.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Plano + ações + vínculos N:N **numa transação** (§9.4 passo 5).
   *
   * A transação é o ponto: uma recomendação sem as ações dela é um plano que a
   * tela oferece e o apply não consegue executar; ações sem os vínculos fazem o
   * apply resolver zero achados. Os três nascem juntos ou nenhum nasce.
   *
   * `null` quando `recommendations_active_unique` recusa — já existe uma ativa
   * para `(ad, kind)`. Recusar é o comportamento correto sob geração concorrente.
   */
  async persistPlan(
    input: PersistPlanInput,
  ): Promise<PersistedRecommendation | null> {
    const { plan } = input;

    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.recommendation.create({
          data: {
            adId: plan.adId,
            organizationId: input.organizationId,
            accountId: input.accountId,
            kind: plan.kind,
            advisory: plan.advisory,
            outOfScopeReason: plan.outOfScopeReason,
            title: plan.title,
            rationale: plan.rationale,
            guidance: plan.guidance,
            impacts: toPrismaJson({
              schemaVersion: 1,
              impacts: plan.impacts,
            }),
            primaryImpactType: plan.primaryImpactType,
            currency: input.currency,
            baseCurrency: input.baseCurrency,
            priority: plan.priority,
            status: input.deferral ? 'DEFERRED_BY_CONFLICT' : 'NEW',
            blockedReason: input.deferral?.reason ?? plan.blockedReason,
            conflictWithId: input.deferral?.conflictWithId ?? null,
            engineVersion: input.engineVersion,
            evidence: toPrismaJson(plan.evidence),
            evidenceAsOf: plan.evidenceAsOf,
            expiresAt: plan.expiresAt,
          },
          select: { id: true },
        });

        const actionIds: string[] = [];

        for (const action of plan.actions) {
          const persisted = await tx.adAction.create({
            data: {
              adId: plan.adId,
              organizationId: input.organizationId,
              // P3: `origin` é obrigatório e `RECOMMENDATION` sem
              // `recommendationId` é erro de schema. Os dois viajam juntos aqui
              // porque é o único lugar que cria ação de origem recomendação.
              origin: 'RECOMMENDATION',
              recommendationId: created.id,
              type: action.type,
              level: action.level,
              parameters: toPrismaJson(
                parseActionParameters(action.type, action.parameters),
              ),
              targetEntityType: action.targetEntityType,
              targetEntityId: action.targetEntityId,
              reversible: action.reversible,
              scopeWarning: action.scopeWarning,
            },
            select: { id: true },
          });

          actionIds.push(persisted.id);
        }

        if (plan.wasteItemIds.length > 0) {
          await tx.recommendationWasteItem.createMany({
            data: plan.wasteItemIds.map((wasteItemId) => ({
              recommendationId: created.id,
              wasteItemId,
            })),
            skipDuplicates: true,
          });
        }

        return {
          id: created.id,
          adId: plan.adId,
          kind: plan.kind,
          actionIds,
        };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.logger.debug(
          `recommendation.already_active adId=${plan.adId} kind=${plan.kind}`,
        );
        return null;
      }

      throw error;
    }
  }

  async supersede(input: {
    organizationId: string;
    supersededById: string;
    adId: string;
    kind: RecommendationKind;
  }): Promise<number> {
    const result = await this.prisma.recommendation.updateMany({
      where: {
        organizationId: input.organizationId,
        adId: input.adId,
        kind: input.kind,
        id: { not: input.supersededById },
        status: { in: ['NEW', 'ACKNOWLEDGED'] },
      },
      data: { status: 'SUPERSEDED', supersededById: input.supersededById },
    });

    return result.count;
  }

  async list(
    query: RecommendationListQuery,
  ): Promise<{ items: RecommendationView[]; hasMore: boolean }> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.status ? { status: query.status } : {}),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(query.adId ? { adId: query.adId } : {}),
        ...(query.advisory !== undefined ? { advisory: query.advisory } : {}),
        // `blockedReason` é o campo, e a pergunta é "há motivo declarado?".
        ...(query.blocked === true ? { blockedReason: { not: null } } : {}),
        ...(query.blocked === false ? { blockedReason: null } : {}),
      },
      include: VIEW_INCLUDE,
      // A ordenação é por gravidade: a tela de recomendação existe para levar
      // ao topo o que mais custa deixar como está.
      orderBy: [{ priority: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
      // Keyset sobre `(priority, id)`. Prisma ordena enum pela ordem de
      // declaração, e é ela que o cursor tem de reproduzir — usar `skip` aqui
      // repetiria linhas a cada ciclo de geração, que é justamente o que §7.0.5
      // proíbe.
      ...(query.cursor
        ? {
            cursor: { id: query.cursor.id },
            skip: 1,
          }
        : {}),
    });

    const hasMore = rows.length > query.limit;

    return {
      items: rows.slice(0, query.limit).map(toView),
      hasMore,
    };
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<RecommendationView | null> {
    const row = await this.prisma.recommendation.findFirst({
      where: { id, organizationId },
      include: VIEW_INCLUDE,
    });

    return row ? toView(row) : null;
  }

  /**
   * §9.7 — os três tipos **separados**, com o realizado vindo do outcome.
   *
   * O join é o que mantém B8: `impacts[]` guarda só o estimado, e somar o
   * realizado a partir dele seria ler a projeção como se fosse medição.
   *
   * **A estimativa é separada em duas populações** desde A2-S9. A redação de
   * A2-S6 somava `impacts[]` de **todas** as recomendações — inclusive
   * dispensadas, expiradas e superseded — e punha o resultado ao lado de um
   * realizado que só pode vir das aplicadas. Enquanto o realizado era sempre
   * zero, a incoerência não aparecia; no instante em que a medição existe, ela
   * viraria uma "taxa de realização" que mede quantas recomendações ainda não
   * foram aplicadas, e não o quanto acertamos.
   */
  async impactSummary(organizationId: string): Promise<ImpactSummary> {
    const [rows, organization] = await Promise.all([
      this.prisma.recommendation.findMany({
        where: {
          organizationId,
          // Terminais que não são aplicação ficam de fora: uma recomendação
          // dispensada não é ganho pendente nem promessa cumprida.
          status: {
            in: ['NEW', 'ACKNOWLEDGED', 'DEFERRED_BY_CONFLICT', 'APPLIED'],
          },
        },
        select: {
          advisory: true,
          status: true,
          impacts: true,
          primaryImpactType: true,
          outcome: {
            select: {
              status: true,
              observedDelta: true,
              verdict: true,
              confounders: true,
              measurementVersion: true,
            },
          },
        },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { baseCurrency: true },
      }),
    ]);

    const totals = new Map<ImpactType, ImpactBucket>();
    const measurement = {
      pending: 0,
      measured: 0,
      abandoned: 0,
      withConfounders: 0,
      versions: new Set<string>(),
    };

    let advisoryExcluded = 0;

    for (const row of rows) {
      // Consultivas **nunca** entram nas métricas de acurácia de P8 (§9.3).
      if (row.advisory) {
        advisoryExcluded += 1;
        continue;
      }

      const applied = row.status === 'APPLIED';

      for (const impact of impactsOf(row.impacts)) {
        const bucket = bucketFor(totals, impact.type);

        if (applied) {
          bucket.appliedEstimatedBase += impact.estimatedBase;
          bucket.appliedCount += 1;
        } else {
          bucket.openEstimatedBase += impact.estimatedBase;
          bucket.openCount += 1;
        }
      }

      const outcome = row.outcome;
      if (!outcome) continue;

      if (outcome.status === 'PENDING_MEASUREMENT') measurement.pending += 1;
      if (outcome.status === 'ABANDONED') measurement.abandoned += 1;
      if (outcome.measurementVersion) {
        measurement.versions.add(outcome.measurementVersion);
      }

      if (outcome.status !== 'MEASURED') continue;

      measurement.measured += 1;
      if (
        Array.isArray(outcome.confounders) &&
        outcome.confounders.length > 0
      ) {
        measurement.withConfounders += 1;
      }

      /**
       * **Um delta primário, nunca uma soma** (DEC-6). Uma recomendação com
       * estimativa de economia **e** de eficiência produz uma medição só — a de
       * `primaryImpactType`. Distribuí-la pelos dois tipos a contaria duas vezes
       * no denominador que autoriza a automação de §20-H3.
       */
      const bucket = bucketFor(
        totals,
        impactTypeOf(row.primaryImpactType as OutcomeDeltaKind),
      );

      bucket.measuredCount += 1;
      if (outcome.verdict) {
        bucket.byVerdict[outcome.verdict] =
          (bucket.byVerdict[outcome.verdict] ?? 0) + 1;
      }

      // `INCONCLUSIVE` grava `observedDelta` nulo: não houve o que medir, e
      // somar zero ali diria "medimos, e deu zero".
      if (outcome.observedDelta !== null) {
        bucket.observedDeltaBase += Number(outcome.observedDelta);
      }
    }

    return {
      baseCurrency: organization?.baseCurrency ?? 'BRL',
      byType: [...totals.entries()].map(([type, value]) => ({
        type,
        ...value,
      })),
      advisoryExcluded,
      measurement: {
        ...measurement,
        versions: [...measurement.versions].sort(),
      },
    };
  }

  async premiseStateFor(input: {
    organizationId: string;
    recommendationId: string;
    evidenceMaxAgeDays: number;
  }): Promise<PremiseState | null> {
    const row = await this.prisma.recommendation.findFirst({
      where: {
        id: input.recommendationId,
        organizationId: input.organizationId,
      },
      include: {
        ad: {
          select: {
            id: true,
            adSetId: true,
            campaignId: true,
            archivedAt: true,
            observedStatus: true,
            syncState: true,
            dataMaturity: true,
            adAccount: { select: { syncHealth: true } },
          },
        },
        actions: { select: { targetEntityType: true, targetEntityId: true } },
        wasteItems: {
          include: { wasteItem: { select: { resolvedAt: true } } },
        },
      },
    });

    if (!row) return null;

    const now = new Date();

    // Uma supressão vencida **não** suprime, e a leitura não pode depender de o
    // job de purga ter rodado: sem o filtro de data, uma supressão de 7 dias
    // silenciaria por 8 no dia em que o cron atrasa.
    const suppression = await this.prisma.recommendationSuppression.findFirst({
      where: {
        organizationId: input.organizationId,
        kind: row.kind,
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { scope: 'ORGANIZATION' },
              { scope: 'AD', scopeId: row.adId },
              ...(row.ad.adSetId
                ? [{ scope: 'AD_SET' as const, scopeId: row.ad.adSetId }]
                : []),
              { scope: 'CAMPAIGN', scopeId: row.ad.campaignId },
            ],
          },
        ],
      },
      select: { id: true },
    });

    return {
      status: row.status as PremiseState['status'],
      expiresAt: row.expiresAt,
      suppressed: suppression !== null,
      linkedWasteItems: row.wasteItems.length,
      openWasteItems: row.wasteItems.filter(
        (link) => link.wasteItem.resolvedAt === null,
      ).length,
      evidenceAsOf: row.evidenceAsOf,
      evidenceMaxAgeDays: input.evidenceMaxAgeDays,
      /**
       * A maturidade **da evidência**, não a do dia mais novo do anúncio.
       *
       * `Ad.dataMaturity` descreve a série corrente e, num anúncio que entrega
       * todo dia, nunca sai de `IMMATURE` — usá-la aqui reprovava a premissa de
       * toda recomendação viva. A que vale é a da janela que sustentou o
       * veredito, gravada com a evidência; o `??` cobre linhas anteriores a
       * esta correção, que só têm o campo do anúncio.
       */
      dataMaturity: (evidenceMaturity(row.evidence) ??
        row.ad.dataMaturity) as PremiseState['dataMaturity'],
      requiresMature: requiresMature(row.kind as RecommendationKind),
      adArchived: row.ad.archivedAt !== null,
      adObservable:
        row.ad.syncState !== 'UNREACHABLE' &&
        row.ad.observedStatus !== 'DELETED',
      integrationReachable: row.ad.adAccount.syncHealth !== 'UNREACHABLE',
      // A2-S7 traz `ActionCapabilityRegistry`, consentimento e kill switch. Até
      // lá as três respondem o valor que **não** bloqueia: fingir bloqueio aqui
      // ensinaria o cliente a tratar um 403 que nunca vai acontecer assim.
      capabilitySupported: row.actions.length > 0,
      consentGranted: true,
      killSwitchOn: false,
      // I2 generalizada: a exclusão é por alvo, e `ActionExecution` em voo só
      // existe a partir de A2-S7.
      writeInFlightId: null,
    };
  }

  async markStatus(input: {
    id: string;
    organizationId: string;
    status: RecommendationStatus;
    reason?: string | null;
  }): Promise<boolean> {
    const result = await this.prisma.recommendation.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        // Só transiciona de estado não terminal: sem isto, dispensar duas vezes
        // sobrescreveria o motivo da primeira.
        status: { in: ['NEW', 'ACKNOWLEDGED', 'DEFERRED_BY_CONFLICT'] },
      },
      data: {
        status: input.status,
        ...(input.status === 'DISMISSED'
          ? { dismissedAt: new Date(), dismissReason: input.reason ?? null }
          : {}),
        ...(input.status === 'EXPIRED'
          ? { blockedReason: input.reason ?? null }
          : {}),
      },
    });

    return result.count > 0;
  }

  async markApplying(input: {
    id: string;
    organizationId: string;
  }): Promise<boolean> {
    const result = await this.prisma.recommendation.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        status: { in: ['NEW', 'ACKNOWLEDGED'] },
      },
      data: { status: 'APPLYING', blockedReason: null },
    });

    return result.count > 0;
  }

  async markApplyFailed(input: {
    id: string;
    organizationId: string;
    reason: string;
  }): Promise<boolean> {
    const result = await this.prisma.recommendation.updateMany({
      where: {
        id: input.id,
        organizationId: input.organizationId,
        status: 'APPLYING',
      },
      data: { status: 'FAILED', blockedReason: input.reason },
    });

    return result.count > 0;
  }

  /**
   * §9.5 passo 6 — `appliedAt` e o outcome **na mesma transação**.
   *
   * O `updateMany` condicionado a `APPLYING` é o que faz a chamada idempotente:
   * um worker reexecutado encontra `APPLIED` e sai sem criar um segundo outcome.
   * A alternativa — checar antes e escrever depois — deixaria a janela em que
   * duas réplicas leem `APPLYING` e ambas inserem.
   */
  async markApplied(input: {
    id: string;
    organizationId: string;
    appliedAt: Date;
    outcome: PreWindowSnapshot;
  }): Promise<{ applied: boolean; outcomeId: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const transitioned = await tx.recommendation.updateMany({
        where: {
          id: input.id,
          organizationId: input.organizationId,
          status: 'APPLYING',
        },
        data: { status: 'APPLIED', appliedAt: input.appliedAt },
      });

      if (transitioned.count === 0) return { applied: false, outcomeId: null };

      const snapshot = input.outcome;
      const created = await tx.recommendationOutcome.create({
        data: {
          recommendationId: snapshot.recommendationId,
          adId: snapshot.adId,
          lineageId: snapshot.lineageId,
          organizationId: snapshot.organizationId,
          status: 'PENDING_MEASUREMENT',
          appliedAt: snapshot.appliedAt,
          windowDays: snapshot.windowDays,
          currency: snapshot.currency,
          baseCurrency: snapshot.baseCurrency,
          fxRateFixed: snapshot.fxRateFixed,
          preSpendBase: snapshot.preSpendBase,
          preRevenueBase: snapshot.preRevenueBase,
          preConversions: snapshot.preConversions,
          preAiScore: snapshot.preAiScore,
          observedDeltaKind: snapshot.observedDeltaKind,
          engineVersion: snapshot.engineVersion,
        },
        select: { id: true },
      });

      return { applied: true, outcomeId: created.id };
    });
  }

  async findActiveByWasteItem(input: {
    organizationId: string;
    wasteItemId: string;
  }): Promise<{ id: string; adId: string } | null> {
    const row = await this.prisma.recommendation.findFirst({
      where: {
        organizationId: input.organizationId,
        // Só as que ainda estão na tela de decisão. `APPLYING` fica de fora de
        // propósito: há escrita em voo, e um segundo `apply-fix` sobre o mesmo
        // plano competiria com ela.
        status: { in: ['NEW', 'ACKNOWLEDGED'] },
        advisory: false,
        wasteItems: { some: { wasteItemId: input.wasteItemId } },
      },
      // Prioridade primeiro: um achado pode estar ligado a mais de um plano
      // ativo, e o que resolve mais é o que o usuário quis ao clicar em "corrigir".
      // O desempate é por `id`, como no keyset da listagem — `Recommendation`
      // não tem `createdAt`, e a evidência é o carimbo mais próximo disso.
      orderBy: [{ priority: 'desc' }, { evidenceAsOf: 'desc' }, { id: 'asc' }],
      select: { id: true, adId: true },
    });

    return row;
  }

  async lifecycleCandidates(
    organizationId: string,
  ): Promise<LifecycleCandidate[]> {
    const rows = await this.prisma.recommendation.findMany({
      where: {
        organizationId,
        status: { in: ['NEW', 'ACKNOWLEDGED', 'DEFERRED_BY_CONFLICT'] },
      },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        conflictWithId: true,
        wasteItems: {
          include: { wasteItem: { select: { resolvedAt: true } } },
        },
      },
    });

    const conflictIds = rows
      .map((row) => row.conflictWithId)
      .filter((id): id is string => id !== null);

    const winners = conflictIds.length
      ? await this.prisma.recommendation.findMany({
          where: { id: { in: conflictIds } },
          select: { id: true, status: true },
        })
      : [];

    const winnerStatus = new Map(winners.map((row) => [row.id, row.status]));

    return rows.map((row) => ({
      id: row.id,
      status: row.status as LifecycleCandidate['status'],
      expiresAt: row.expiresAt,
      linkedWasteItems: row.wasteItems.length,
      openWasteItems: row.wasteItems.filter(
        (link) => link.wasteItem.resolvedAt === null,
      ).length,
      conflictWithId: row.conflictWithId,
      conflictWinnerStatus: row.conflictWithId
        ? ((winnerStatus.get(row.conflictWithId) ??
            null) as LifecycleCandidate['conflictWinnerStatus'])
        : null,
    }));
  }

  async applyTransitions(
    transitions: Array<{
      id: string;
      to: RecommendationStatus;
      reason: string;
    }>,
  ): Promise<number> {
    let affected = 0;

    for (const transition of transitions) {
      const result = await this.prisma.recommendation.updateMany({
        where: { id: transition.id },
        data: {
          status: transition.to,
          blockedReason: transition.to === 'NEW' ? null : transition.reason,
          // Reabilitada volta sem o vínculo de conflito: mantê-lo faria o
          // próximo ciclo do job achar que ela ainda está diferida.
          ...(transition.to === 'NEW' ? { conflictWithId: null } : {}),
        },
      });

      affected += result.count;
    }

    return affected;
  }
}

/** Kinds cuja evidência depende de conversão — e conversão é re-declarada. */
function requiresMature(kind: RecommendationKind): boolean {
  return (
    kind === 'PAUSE_UNDERPERFORMING_AD' ||
    kind === 'REDUCE_BUDGET_HIGH_CPA' ||
    kind === 'SCALE_WINNING_AD'
  );
}

function impactsOf(value: unknown): Array<{
  type: ImpactType;
  estimatedBase: number;
  horizonDays: number;
  confidence: number;
}> {
  const parsed = fromPrismaJsonObject(value as never);
  const impacts = parsed.impacts;

  if (!Array.isArray(impacts)) return [];

  return impacts.filter(
    (
      item,
    ): item is {
      type: ImpactType;
      estimatedBase: number;
      horizonDays: number;
      confidence: number;
    } =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as { estimatedBase?: unknown }).estimatedBase === 'number',
  );
}

/** O tipo de impacto que cada delta medido alimenta (§9.7). */
type ImpactBucket = {
  openEstimatedBase: number;
  openCount: number;
  appliedEstimatedBase: number;
  appliedCount: number;
  observedDeltaBase: number;
  measuredCount: number;
  byVerdict: Record<string, number>;
};

function bucketFor(
  totals: Map<ImpactType, ImpactBucket>,
  type: ImpactType,
): ImpactBucket {
  const existing = totals.get(type);
  if (existing) return existing;

  const created: ImpactBucket = {
    openEstimatedBase: 0,
    openCount: 0,
    appliedEstimatedBase: 0,
    appliedCount: 0,
    observedDeltaBase: 0,
    measuredCount: 0,
    byVerdict: {},
  };

  totals.set(type, created);
  return created;
}

function impactTypeOf(kind: OutcomeDeltaKind): ImpactType {
  if (kind === 'SPEND_AVOIDED') return 'SAVINGS';
  if (kind === 'REVENUE_DELTA') return 'REVENUE_UPLIFT';
  return 'EFFICIENCY_GAIN';
}

function toView(row: ViewRow): RecommendationView {
  const impacts = impactsOf(row.impacts);
  const realized = row.outcome?.observedDelta;
  const primary = row.primaryImpactType as OutcomeDeltaKind;

  return {
    id: row.id,
    ad: {
      id: row.ad.id,
      lineageId: row.ad.lineageId,
      name: row.ad.name,
      platform: row.ad.platform,
      externalAdId: row.ad.externalAdId,
      observedStatus: row.ad.observedStatus,
      campaign: { id: row.ad.campaign.id, name: row.ad.campaign.name },
      adSet: row.ad.adSet
        ? { id: row.ad.adSet.id, name: row.ad.adSet.name }
        : null,
    },
    kind: row.kind as RecommendationKind,
    advisory: row.advisory,
    outOfScopeReason: row.outOfScopeReason,
    title: row.title,
    rationale: row.rationale,
    guidance: row.guidance,
    priority: row.priority as RecommendationPriority,
    status: row.status as RecommendationStatus,
    blockedReason: row.blockedReason,
    conflictWithId: row.conflictWithId,
    impacts: impacts.map((impact) => ({
      type: impact.type,
      estimated: moneyView({
        value: impact.estimatedBase,
        currency: row.baseCurrency,
        valueBase: impact.estimatedBase,
        baseCurrency: row.baseCurrency,
      }),
      horizonDays: impact.horizonDays,
      confidence: impact.confidence,
      // O realizado só existe para o tipo **primário** (DEC-6), e só depois de
      // a janela pós fechar (A2-S9). `null` aqui é "ainda não medido", não zero.
      realized:
        realized !== null &&
        realized !== undefined &&
        impact.type === impactTypeOf(primary)
          ? moneyView({
              value: Number(realized),
              currency: row.baseCurrency,
              valueBase: Number(realized),
              baseCurrency: row.baseCurrency,
            })
          : null,
    })),
    primaryImpactType: primary,
    baseCurrency: row.baseCurrency,
    wasteItems: row.wasteItems.map((link) => ({
      id: link.wasteItem.id,
      type: link.wasteItem.type,
      open: link.wasteItem.resolvedAt === null,
    })),
    actions: row.actions.map((action) => ({
      id: action.id,
      type: action.type,
      level: action.level,
      parameters: fromPrismaJsonObject(action.parameters),
      targetEntityType: action.targetEntityType,
      targetEntityId: action.targetEntityId,
      scopeWarning: action.scopeWarning,
      reversible: action.reversible,
      /**
       * Platform-aware desde A2-S8: `REPLACE_CREATIVE` recria no Google e edita
       * em lugar na Meta. A lista global anterior respondia igual para as duas.
       */
      requiresRecreate: requiresRecreate(
        row.ad.platform,
        action.type as AdActionType,
      ),
    })),
    dataMaturity: row.ad.dataMaturity as RecommendationView['dataMaturity'],
    evidence: fromPrismaJsonObject(row.evidence ?? {}),
    evidenceAsOf: row.evidenceAsOf,
    expiresAt: row.expiresAt,
    engineVersion: row.engineVersion,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}

/**
 * A maturidade que a geração registrou junto da evidência.
 *
 * Mora no `Json` de `evidence` e não numa coluna própria porque é atributo
 * **daquela** evidência: uma coluna sugeriria um estado corrente do anúncio, que
 * é exatamente a confusão que este campo existe para desfazer.
 */
function evidenceMaturity(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== 'object') return null;

  const value = (evidence as { windowMaturity?: unknown }).windowMaturity;
  return typeof value === 'string' ? value : null;
}
