import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from 'generated/prisma/client';
import type {
  ActionLevel,
  AdActionType,
  AdStatus,
} from 'src/modules/ads/domain/platform/platform-profile';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import {
  ActionExecutionView,
  ActionExecutionsRepositoryInterface,
  EnqueueActionInput,
  EnqueueResult,
  ExecutableAction,
  ExecutionStatus,
  RecommendationPlanStatus,
} from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { parseActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** Violação de unicidade. Qual índice foi é o que decide a resposta. */
const UNIQUE_VIOLATION = 'P2002';

@Injectable()
export class ActionExecutionsPrismaRepository extends ActionExecutionsRepositoryInterface {
  private readonly logger = new Logger(ActionExecutionsPrismaRepository.name);

  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async enqueue(input: EnqueueActionInput): Promise<EnqueueResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // G15 — parâmetros passam pelo schema **do tipo** antes de virar linha.
        // Um schema genérico aceitaria orçamento sem valor, e o erro apareceria
        // na plataforma — movendo, ou não movendo, dinheiro real.
        const parameters = parseActionParameters(
          input.actionType,
          input.parameters as unknown as Record<string, unknown>,
        ) as Prisma.InputJsonValue;

        /**
         * Aplicar uma recomendação **executa o plano gravado**, não cria outro
         * (§9.5 passo 4). O que falta na ação planejada é o `previousState`: ele
         * é foto do instante da escrita, e a geração da madrugada não tinha como
         * capturá-lo. O `update` é escopado por organização e por recomendação —
         * um id de ação de outro tenant não casa e a transação inteira falha.
         */
        const action = input.existingActionId
          ? await tx.adAction.update({
              where: {
                id: input.existingActionId,
                organizationId: input.organizationId,
                recommendationId: input.recommendationId,
              },
              data: {
                previousState:
                  (input.previousState as Prisma.InputJsonValue | null) ??
                  undefined,
                reversible: input.reversible,
                scopeWarning: input.scopeWarning,
              },
              select: { id: true },
            })
          : await tx.adAction.create({
              data: {
                adId: input.adId,
                organizationId: input.organizationId,
                recommendationId: input.recommendationId,
                origin: input.origin,
                type: input.actionType,
                level: input.level,
                parameters,
                targetEntityType: input.targetEntityType,
                targetEntityId: input.targetEntityId,
                previousState:
                  (input.previousState as Prisma.InputJsonValue | null) ??
                  undefined,
                reversible: input.reversible,
                scopeWarning: input.scopeWarning,
              },
              select: { id: true },
            });

        const execution = await tx.actionExecution.create({
          data: {
            actionId: action.id,
            organizationId: input.organizationId,
            targetEntityType: input.targetEntityType,
            targetEntityId: input.targetEntityId,
            status: 'QUEUED',
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            dryRun: input.dryRun,
            expiresAt: input.expiresAt,
            requestedByAccountId: input.requestedByAccountId,
            correlationId: input.correlationId,
          },
          select: { id: true },
        });

        /**
         * §8.4 — o estado desejado entra **na mesma transação** da execução, e
         * o `syncState` vai a `PENDING_WRITE`.
         *
         * Gravar o desejado depois deixaria uma janela em que a execução existe
         * e o anúncio ainda diz "em sincronia": nela, o reconcile leria
         * divergência com a plataforma e a reportaria como drift causado por
         * terceiros — quando o autor da divergência somos nós, três
         * milissegundos antes.
         *
         * **Dry-run não move estado nenhum.** Ele não escreve na plataforma, e
         * marcar o anúncio como "pausando…" por causa de uma validação mentiria
         * na tela.
         */
        if (!input.dryRun && input.desiredStatus) {
          await tx.ad.update({
            where: { id: input.adId },
            data: {
              desiredStatus: input.desiredStatus,
              desiredStatusSetAt: new Date(),
              syncState: 'PENDING_WRITE',
              syncStateAt: new Date(),
              version: { increment: 1 },
            },
          });
        }

        return {
          kind: 'ENQUEUED' as const,
          executionId: execution.id,
          actionId: action.id,
        };
      });
    } catch (error) {
      return this.classifyEnqueueFailure(error, input);
    }
  }

  /**
   * Os dois índices que podem recusar a linha, distinguidos pelo alvo.
   *
   * A checagem prévia no use case não substitui isto: entre ler "não há escrita
   * em voo" e inserir a linha cabe outra requisição, e é o banco — não o código
   * — quem arbitra. Traduzir a violação em vez de propagá-la é o que faz a
   * corrida virar um 409 tipado em vez de um 500.
   */
  private async classifyEnqueueFailure(
    error: unknown,
    input: EnqueueActionInput,
  ): Promise<EnqueueResult> {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== UNIQUE_VIOLATION
    ) {
      throw error;
    }

    /**
     * `meta.target` é `unknown` no tipo do Prisma e vem como string ou lista de
     * colunas conforme o driver. `JSON.stringify` cobre as duas sem depender de
     * qual, e sem produzir o `[object Object]` que uma coerção direta daria —
     * que faria toda violação cair no ramo de I2, inclusive as de idempotência.
     */
    const target = JSON.stringify(error.meta?.target ?? '');

    if (target.includes('idempotency')) {
      const existing = await this.findByIdempotencyKey({
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
      });

      /**
       * Chegar aqui significa que outra requisição com a **mesma chave** venceu
       * a corrida. Se o dígito bate, é o mesmo pedido e o cliente recebe o
       * resultado dela — que é exatamente o contrato de A8. Se não bate, o
       * chamador transforma em `IDEMPOTENCY_KEY_REUSED`.
       */
      if (existing?.requestDigest === input.requestDigest) {
        return { kind: 'IDEMPOTENT_REPLAY', executionId: existing.executionId };
      }

      throw error;
    }

    const inFlight = await this.prisma.actionExecution.findFirst({
      where: {
        organizationId: input.organizationId,
        targetEntityType: input.targetEntityType,
        targetEntityId: input.targetEntityId,
        status: { in: ['QUEUED', 'RUNNING'] },
      },
      select: { id: true },
    });

    this.logger.warn(
      `action.enqueue_conflict target=${input.targetEntityType}:${input.targetEntityId} ` +
        `inFlight=${inFlight?.id ?? 'desconhecida'}`,
    );

    return {
      kind: 'WRITE_IN_FLIGHT',
      inFlightExecutionId: inFlight?.id ?? null,
    };
  }

  async findByIdempotencyKey(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<{ executionId: string; requestDigest: string } | null> {
    const row = await this.prisma.actionExecution.findUnique({
      where: {
        organizationId_idempotencyKey: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true, requestDigest: true },
    });

    return row
      ? { executionId: row.id, requestDigest: row.requestDigest }
      : null;
  }

  async findExecution(input: {
    organizationId: string;
    executionId: string;
  }): Promise<ActionExecutionView | null> {
    const row = await this.prisma.actionExecution.findFirst({
      where: { id: input.executionId, organizationId: input.organizationId },
      select: {
        id: true,
        organizationId: true,
        targetEntityType: true,
        targetEntityId: true,
        status: true,
        attempt: true,
        dryRun: true,
        validationDepth: true,
        idempotencyKey: true,
        expiresAt: true,
        startedAt: true,
        completedAt: true,
        errorCode: true,
        errorMessage: true,
        resultPlatformEntityId: true,
        verificationAttempt: true,
        verifiedAt: true,
        verificationResult: true,
        createdAt: true,
        action: {
          select: {
            id: true,
            adId: true,
            type: true,
            level: true,
            parameters: true,
            ad: { select: { observedStatus: true, desiredStatus: true } },
          },
        },
      },
    });

    if (!row) return null;

    return {
      executionId: row.id,
      actionId: row.action.id,
      organizationId: row.organizationId,
      adId: row.action.adId,
      actionType: row.action.type as AdActionType,
      level: row.action.level as ActionLevel,
      targetEntityType: row.targetEntityType as ActionLevel,
      targetEntityId: row.targetEntityId,
      parameters: row.action.parameters,
      status: row.status as ExecutionStatus,
      attempt: row.attempt,
      dryRun: row.dryRun,
      validationDepth: row.validationDepth,
      idempotencyKey: row.idempotencyKey,
      expiresAt: row.expiresAt,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      resultPlatformEntityId: row.resultPlatformEntityId,
      verificationAttempt: row.verificationAttempt,
      verifiedAt: row.verifiedAt,
      verificationResult: row.verificationResult,
      observedStatus: row.action.ad.observedStatus as AdStatus,
      desiredStatus: (row.action.ad.desiredStatus as AdStatus | null) ?? null,
      createdAt: row.createdAt,
    };
  }

  async countExecutionsSince(input: {
    organizationId: string;
    since: Date;
  }): Promise<number> {
    return this.prisma.actionExecution.count({
      where: {
        organizationId: input.organizationId,
        dryRun: false,
        createdAt: { gte: input.since },
      },
    });
  }

  async loadForExecution(
    executionId: string,
  ): Promise<ExecutableAction | null> {
    const row = await this.prisma.actionExecution.findUnique({
      where: { id: executionId },
      select: {
        id: true,
        organizationId: true,
        targetEntityType: true,
        targetEntityId: true,
        status: true,
        attempt: true,
        dryRun: true,
        idempotencyKey: true,
        correlationId: true,
        expiresAt: true,
        requestedByAccountId: true,
        verificationAttempt: true,
        action: {
          select: {
            id: true,
            adId: true,
            type: true,
            origin: true,
            recommendationId: true,
            level: true,
            parameters: true,
            previousState: true,
            ad: {
              select: {
                platform: true,
                externalAdId: true,
                desiredStatus: true,
                adSet: { select: { id: true, externalAdSetId: true } },
                campaign: { select: { id: true, externalCampaignId: true } },
                adAccount: {
                  select: {
                    id: true,
                    currency: true,
                    externalAccountId: true,
                    integrationId: true,
                    organization: { select: { actionsEnabled: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!row) return null;

    const ad = row.action.ad;
    /**
     * Conta sem integração corrente é conta desconectada (rebind de A2-S3, P10).
     * Não há com que escrever, e devolver a foto assim mesmo empurraria a
     * descoberta para o worker — que só notaria ao pedir a credencial, já
     * tendo marcado a execução como `RUNNING`.
     */
    const integrationId = ad.adAccount.integrationId;
    if (!integrationId) return null;

    const level = row.targetEntityType as ActionLevel;

    /**
     * O id externo resolvido **aqui**, junto do resto da foto. Resolvê-lo no
     * worker exigiria uma segunda consulta e abriria a janela que esta consulta
     * única existe para fechar.
     */
    const targetExternalId =
      level === 'AD'
        ? ad.externalAdId
        : level === 'AD_SET'
          ? (ad.adSet?.externalAdSetId ?? null)
          : ad.campaign.externalCampaignId;

    if (!targetExternalId) return null;

    return {
      executionId: row.id,
      organizationId: row.organizationId,
      actionId: row.action.id,
      adId: row.action.adId,
      actionType: row.action.type as AdActionType,
      origin: row.action.origin as ExecutableAction['origin'],
      recommendationId: row.action.recommendationId,
      level: row.action.level as ActionLevel,
      targetEntityType: level,
      targetEntityId: row.targetEntityId,
      targetExternalId,
      parameters: row.action.parameters,
      previousState: row.action.previousState,
      status: row.status as ExecutionStatus,
      attempt: row.attempt,
      dryRun: row.dryRun,
      idempotencyKey: row.idempotencyKey,
      correlationId: row.correlationId,
      expiresAt: row.expiresAt,
      requestedByAccountId: row.requestedByAccountId,
      desiredStatus: (ad.desiredStatus as AdStatus | null) ?? null,
      platform: ad.platform,
      integrationId,
      adAccountId: ad.adAccount.id,
      accountCurrency: ad.adAccount.currency,
      externalAccountId: ad.adAccount.externalAccountId,
      organizationActionsEnabled: ad.adAccount.organization.actionsEnabled,
      verificationAttempt: row.verificationAttempt,
    };
  }

  async markRunning(input: {
    executionId: string;
    attempt: number;
  }): Promise<boolean> {
    /**
     * `updateMany` com `status: 'QUEUED'` no `where` é um compare-and-set: o
     * banco arbitra. Ler-e-escrever deixaria duas réplicas passarem pela mesma
     * porta, e as duas chamariam a plataforma.
     */
    const { count } = await this.prisma.actionExecution.updateMany({
      where: { id: input.executionId, status: 'QUEUED' },
      data: {
        status: 'RUNNING',
        attempt: input.attempt,
        startedAt: new Date(),
      },
    });

    return count === 1;
  }

  async settle(input: {
    executionId: string;
    status: Exclude<ExecutionStatus, 'QUEUED' | 'RUNNING'>;
    errorCode?: string | null;
    errorMessage?: string | null;
    responsePayload?: unknown;
    resultPlatformEntityId?: string | null;
    clearDesiredStatus?: boolean;
  }): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const execution = await tx.actionExecution.update({
        where: { id: input.executionId },
        data: {
          status: input.status,
          completedAt: new Date(),
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          responsePayload:
            (input.responsePayload as Prisma.InputJsonValue) ?? undefined,
          resultPlatformEntityId: input.resultPlatformEntityId ?? undefined,
        },
        select: { action: { select: { adId: true } } },
      });

      if (!input.clearDesiredStatus) return;

      /**
       * O estado otimista sai; **o `syncState` não é tocado**.
       *
       * §3.5 dá a `platform-actions` uma transição só — entrar em
       * `PENDING_WRITE` — e a proibição de sair existe porque quem confirma o
       * que a plataforma fez é quem a lê. Depois de uma escrita recusada nós
       * sabemos menos, não mais: o caminho de volta é o `sync` reler o anúncio,
       * e é ele que o worker enfileira.
       */
      await tx.ad.update({
        where: { id: execution.action.adId },
        data: { desiredStatus: null, desiredStatusSetAt: null },
      });
    });
  }

  async recordVerification(input: {
    executionId: string;
    attempt: number;
    result: 'CONFIRMED' | 'DIVERGED' | 'INCONCLUSIVE' | 'UNVERIFIED_WRITE';
    verifiedAt: Date | null;
  }): Promise<void> {
    await this.prisma.actionExecution.update({
      where: { id: input.executionId },
      data: {
        verificationAttempt: input.attempt,
        verificationResult: input.result,
        verifiedAt: input.verifiedAt,
      },
    });
  }

  async enqueueRevert(input: {
    originalExecutionId: string;
    organizationId: string;
    requestedByAccountId: string;
    actionType: AdActionType;
    parameters: AdActionParameters;
    previousState: Record<string, unknown> | null;
    idempotencyKey: string;
    requestDigest: string;
    correlationId: string | null;
    expiresAt: Date;
    desiredStatus: AdStatus | null;
  }): Promise<EnqueueResult> {
    const original = await this.prisma.actionExecution.findFirst({
      where: {
        id: input.originalExecutionId,
        organizationId: input.organizationId,
      },
      select: {
        action: {
          select: {
            id: true,
            adId: true,
            type: true,
            level: true,
            targetEntityType: true,
            targetEntityId: true,
          },
        },
      },
    });

    if (!original) throw new Error('Execução original não encontrada');

    try {
      return await this.prisma.$transaction(async (tx) => {
        const action = await tx.adAction.create({
          data: {
            adId: original.action.adId,
            organizationId: input.organizationId,
            /**
             * `REVERT`, não a origem da original. A reversão é decisão própria
             * de quem a pediu; herdar `RECOMMENDATION` faria o dataset de P8
             * contar como resultado da recomendação um movimento que a
             * desfez.
             */
            origin: 'REVERT',
            /**
             * O tipo **inverso**, não o da original: reverter um `PAUSE_AD` é
             * um `ENABLE_AD`. A Meta tem caminhos diferentes por tipo e a
             * capability é declarada por tipo — manter o original faria a
             * reversão ser recusada pela mesma validação que aprovou a ação,
             * ou aceita e sem efeito.
             */
            type: input.actionType,
            level: original.action.level,
            parameters: parseActionParameters(
              input.actionType,
              input.parameters as unknown as Record<string, unknown>,
            ) as Prisma.InputJsonValue,
            targetEntityType: original.action.targetEntityType,
            targetEntityId: original.action.targetEntityId,
            previousState:
              (input.previousState as Prisma.InputJsonValue | null) ??
              undefined,
            /**
             * A reversão de uma reversão não é oferecida: seria refazer a ação
             * original por um caminho que não passa pelas guardas dela.
             */
            reversible: false,
          },
          select: { id: true },
        });

        const execution = await tx.actionExecution.create({
          data: {
            actionId: action.id,
            organizationId: input.organizationId,
            targetEntityType: original.action.targetEntityType,
            targetEntityId: original.action.targetEntityId,
            status: 'QUEUED',
            idempotencyKey: input.idempotencyKey,
            requestDigest: input.requestDigest,
            dryRun: false,
            expiresAt: input.expiresAt,
            requestedByAccountId: input.requestedByAccountId,
            correlationId: input.correlationId,
          },
          select: { id: true },
        });

        // O vínculo na original, na mesma transação: uma reversão sem ele
        // deixaria a original afirmando para sempre que nunca foi desfeita.
        await tx.adAction.update({
          where: { id: original.action.id },
          data: { revertedByActionId: action.id },
        });

        if (input.desiredStatus) {
          await tx.ad.update({
            where: { id: original.action.adId },
            data: {
              desiredStatus: input.desiredStatus,
              desiredStatusSetAt: new Date(),
              syncState: 'PENDING_WRITE',
              syncStateAt: new Date(),
              version: { increment: 1 },
            },
          });
        }

        return {
          kind: 'ENQUEUED' as const,
          executionId: execution.id,
          actionId: action.id,
        };
      });
    } catch (error) {
      /**
       * A reversão passa pelos **mesmos** índices: I2 sobre o alvo e
       * idempotência por tenant. Desfazer não é um caminho privilegiado — duas
       * reversões concorrentes sobre o mesmo anúncio são tão perigosas quanto
       * duas escritas.
       */
      return this.classifyEnqueueFailure(error, {
        organizationId: input.organizationId,
        idempotencyKey: input.idempotencyKey,
        requestDigest: input.requestDigest,
        targetEntityType: original.action.targetEntityType as ActionLevel,
        targetEntityId: original.action.targetEntityId,
      } as EnqueueActionInput);
    }
  }

  async findExpired(input: { now: Date; limit: number }) {
    const rows = await this.prisma.actionExecution.findMany({
      where: {
        status: { in: ['QUEUED', 'RUNNING'] },
        expiresAt: { lt: input.now },
      },
      orderBy: { expiresAt: 'asc' },
      take: input.limit,
      select: {
        id: true,
        organizationId: true,
        status: true,
        attempt: true,
        requestedByAccountId: true,
        action: { select: { adId: true, recommendationId: true } },
      },
    });

    return rows.map((row) => ({
      executionId: row.id,
      organizationId: row.organizationId,
      adId: row.action.adId,
      attempt: row.attempt,
      status: row.status as ExecutionStatus,
      recommendationId: row.action.recommendationId,
      requestedByAccountId: row.requestedByAccountId,
    }));
  }

  /**
   * §9.5 passo 5 — o plano assentou quando **nenhuma execução real** dele
   * continua em voo.
   *
   * `plannedActions` conta as `AdAction` da recomendação, não as execuções: uma
   * ação recusada por guarda antes de enfileirar não gera execução nenhuma, e
   * contar só execuções faria um plano de três ações com uma recusada parecer um
   * plano de duas — inteiramente bem-sucedido.
   */
  async planStatusFor(input: {
    organizationId: string;
    recommendationId: string;
  }): Promise<RecommendationPlanStatus> {
    const [plannedActions, rows] = await Promise.all([
      this.prisma.adAction.count({
        where: {
          organizationId: input.organizationId,
          recommendationId: input.recommendationId,
        },
      }),
      this.prisma.actionExecution.findMany({
        where: {
          organizationId: input.organizationId,
          dryRun: false,
          action: { recommendationId: input.recommendationId },
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          completedAt: true,
        },
      }),
    ]);

    let pending = 0;
    let succeeded = 0;
    let failed = 0;
    let lastSettledExecutionId: string | null = null;
    let settledAt: Date | null = null;

    for (const row of rows) {
      if (row.status === 'QUEUED' || row.status === 'RUNNING') {
        pending += 1;
        continue;
      }

      if (row.status === 'SUCCEEDED') succeeded += 1;
      else failed += 1;

      // O desempate é por `completedAt`, e a ausência dele conta como "assentou
      // agora": uma execução terminal sem carimbo é anomalia, e tratá-la como
      // não assentada travaria o plano para sempre.
      const completedAt = row.completedAt ?? new Date();
      if (!settledAt || completedAt >= settledAt) {
        settledAt = completedAt;
        lastSettledExecutionId = row.id;
      }
    }

    return {
      plannedActions,
      pending,
      succeeded,
      failed,
      executionIds: rows.map((row) => row.id),
      lastSettledExecutionId,
      settledAt,
    };
  }
}
