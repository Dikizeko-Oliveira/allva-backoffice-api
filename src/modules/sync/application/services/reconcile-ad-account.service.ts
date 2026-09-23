import { Injectable, Logger } from '@nestjs/common';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import type { AdStatus } from 'src/modules/ads/domain/platform/platform-profile';
import { transitionSyncState } from 'src/modules/ads/domain/ad-sync-state';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import {
  AdStructureRepositoryInterface,
  AdSyncSnapshot,
} from 'src/modules/sync/domain/ports/ad-structure.repository';
import { SyncOperationsRepositoryInterface } from 'src/modules/sync/domain/ports/sync-operations.repository';
import {
  evaluateDrift,
  evaluateFreshness,
} from 'src/modules/sync/domain/drift';
import { RefreshAdsService } from './refresh-ads.service';

export type ReconcileOutcome = {
  adAccountId: string;
  verified: number;
  pending: number;
  drifted: number;
  staleForMetrics: number;
  unreachable: number;
};

/**
 * ④ RECONCILIAÇÃO (§8.5).
 *
 * **(a) Drift** compara o observado com a **nossa intenção** — só para ads com
 * `desiredStatus`. Antes de decidir, este serviço **relê** os anúncios em voo
 * pelo refresh dirigido: a escada de verificação (§8.5) só significa alguma
 * coisa se cada degrau trouxer observação nova. Uma escada que reavalia o mesmo
 * dado quatro vezes declara `UNVERIFIED_WRITE` sobre uma escrita que talvez
 * tenha funcionado.
 *
 * **(b) Mudança externa** é detectada **onde a observação acontece** —
 * `StructureIngestService`, que compara o status que chegou com o que estava
 * gravado e emite `ad.status.changed` com `source = EXTERNAL`. Repetir a
 * comparação aqui exigiria guardar uma cópia do status anterior só para este
 * serviço, e duas fontes para o mesmo fato divergem: a reconciliação passaria a
 * reportar mudanças que o ingest já reportou, ou a perdê-las quando os dois
 * caminhos discordassem sobre qual era o valor "anterior".
 *
 * **(c) Frescor** separa `STALE` (métrica velha) de `UNREACHABLE` (não sabemos o
 * que o anúncio é). Um `STALE` continua apto a receber ação; um `UNREACHABLE`,
 * não — e essa diferença é lida pela tabela de degradação de §8.7.
 */
@Injectable()
export class ReconcileAdAccountService {
  private readonly logger = new Logger(ReconcileAdAccountService.name);

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly structure: AdStructureRepositoryInterface,
    private readonly operations: SyncOperationsRepositoryInterface,
    private readonly refresh: RefreshAdsService,
    private readonly events: DomainEventBus,
  ) {}

  async execute(input: {
    adAccountId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<ReconcileOutcome> {
    const now = input.now ?? new Date();
    const account = await this.accounts.findById(input.adAccountId);
    if (!account) throw new Error(`AdAccount ${input.adAccountId} não existe`);

    const emit = { ...input.ctx, organizationId: account.organizationId };
    const outcome: ReconcileOutcome = {
      adAccountId: account.id,
      verified: 0,
      pending: 0,
      drifted: 0,
      staleForMetrics: 0,
      unreachable: 0,
    };

    const operation = await this.operations.open({
      organizationId: account.organizationId,
      integrationId: account.integrationId ?? '',
      adAccountId: account.id,
      direction: 'INBOUND',
      kind: 'RECONCILIATION',
      trigger: 'RECONCILE',
    });

    const ads = await this.structure.listForReconciliation(account.id);
    const inFlight = ads.filter(
      (ad) => ad.desiredStatus !== null && ad.desiredStatusSetAt !== null,
    );

    // Relê só os que têm intenção em voo. O refresh dirigido coalesce numa
    // chamada e respeita o mesmo balde de R4 que o ingest.
    if (inFlight.length > 0) {
      await this.refresh.execute({
        organizationId: account.organizationId,
        adIds: inFlight.map((ad) => ad.id),
        ctx: input.ctx,
        now,
      });
    }

    const observed = new Map(
      (
        await this.structure.findAdsByIds(
          account.organizationId,
          inFlight.map((ad) => ad.id),
        )
      ).map((ad) => [ad.id, ad]),
    );

    for (const stale of inFlight) {
      const ad = observed.get(stale.id) ?? stale;
      if (!ad.desiredStatus || !ad.desiredStatusSetAt) continue;

      const verdict = evaluateDrift({
        observedStatus: ad.observedStatus,
        desiredStatus: ad.desiredStatus,
        desiredStatusSetAt: ad.desiredStatusSetAt,
        attempt: attemptOf(ad),
        now,
      });

      if (verdict.kind === 'IN_SYNC') {
        outcome.verified += 1;
        await this.structure.applySyncState({
          adIds: [ad.id],
          syncState: transitionSyncState({
            from: 'PENDING_WRITE',
            to: 'IN_SYNC',
            actor: 'sync',
          }),
          syncStateAt: now,
          driftDetails: null,
        });
        this.events.emitFrom(emit, 'action.verified', {
          adId: ad.id,
          executionId: executionIdOf(ad) ?? '',
          verificationResult: 'CONFIRMED',
        });
        continue;
      }

      if (verdict.kind === 'DRIFTED') {
        outcome.drifted += 1;
        await this.structure.applySyncState({
          adIds: [ad.id],
          syncState: transitionSyncState({
            from: 'PENDING_WRITE',
            to: 'DRIFTED',
            actor: 'sync',
          }),
          syncStateAt: now,
          driftDetails: {
            ...(ad.driftDetails ?? {}),
            cause: verdict.cause,
            expected: ad.desiredStatus,
            observed: ad.observedStatus,
            attemptsExhausted: verdict.attemptsExhausted,
            // Fica registrado de onde veio o instante da observação: quem
            // investigar precisa distinguir timestamp da plataforma do limite
            // inferior que a guarda de §8.4.1 usa como fallback (B4).
            observedAsOf: ad.observedAsOf?.toISOString() ?? null,
          },
        });

        this.events.emitFrom(emit, 'ad.drifted', {
          adId: ad.id,
          expected: toLifecycle(ad.desiredStatus),
          observed: toLifecycle(ad.observedStatus),
          driftCause: verdict.cause,
        });
        // Estado terminal: é ele que libera I2 e impede o travamento
        // permanente. A `ActionExecution` correspondente vai a terminal em
        // `platform-actions` (A2-S7), que é quem a possui; aqui o anúncio já
        // deixa de esperar por uma escrita que ninguém confirmou.
        this.events.emitFrom(emit, 'action.verified', {
          adId: ad.id,
          executionId: executionIdOf(ad) ?? '',
          verificationResult: 'UNVERIFIED_WRITE',
        });
        continue;
      }

      outcome.pending += 1;
      if (verdict.kind === 'PENDING') {
        await this.structure.applySyncState({
          adIds: [ad.id],
          syncState: 'PENDING_WRITE',
          syncStateAt: now,
          driftDetails: {
            ...(ad.driftDetails ?? {}),
            verificationAttempt: verdict.attempt,
            nextAttemptAt: verdict.nextAttemptAt.toISOString(),
          },
        });
      }
    }

    // (c) frescor, sobre a conta inteira.
    const buckets = this.freshnessBuckets({ ads, account, now });
    outcome.staleForMetrics = buckets.STALE.length;
    outcome.unreachable = buckets.UNREACHABLE.length;

    for (const [state, ids] of Object.entries(buckets)) {
      if (ids.length === 0) continue;
      await this.structure.applySyncState({
        adIds: ids,
        syncState: transitionSyncState({
          from: 'STALE',
          to: state as 'IN_SYNC' | 'STALE' | 'UNREACHABLE',
          actor: 'sync',
        }),
        syncStateAt: now,
      });
    }

    await this.operations.close(operation.id, {
      status: 'SUCCEEDED',
      entitiesRead: ads.length,
      entitiesWritten: outcome.verified + outcome.drifted,
      driftsDetected: outcome.drifted,
      // Reconciliação **nunca** habilita arquivamento: ela não lê a conta
      // inteira, e `wasComplete` é uma afirmação sobre cobertura de leitura.
      wasComplete: false,
      stepResults: [
        { step: 'OBSERVED_STATUS', status: 'SUCCEEDED', count: ads.length },
      ],
    });

    if (outcome.drifted > 0) {
      this.logger.warn(
        `sync.drift adAccountId=${account.id} drifted=${outcome.drifted}`,
      );
    }

    return outcome;
  }

  private freshnessBuckets(input: {
    ads: AdSyncSnapshot[];
    account: { integrationId: string | null; syncHealth: string };
    now: Date;
  }): Record<'IN_SYNC' | 'STALE' | 'UNREACHABLE', string[]> {
    const buckets: Record<'IN_SYNC' | 'STALE' | 'UNREACHABLE', string[]> = {
      IN_SYNC: [],
      STALE: [],
      UNREACHABLE: [],
    };

    const integrationAvailable =
      Boolean(input.account.integrationId) &&
      input.account.syncHealth !== 'UNREACHABLE';

    for (const ad of input.ads) {
      // Anúncio com escrita em voo não entra na conta de frescor: `PENDING_WRITE`
      // é do ramo (a), e sobrescrevê-lo aqui apagaria a intenção antes de a
      // escada terminar.
      if (ad.desiredStatus) continue;

      const verdict = evaluateFreshness({
        lastMetricsSyncAt: ad.lastMetricsSyncAt,
        lastStructureSyncAt: ad.lastStructureSyncAt,
        integrationAvailable,
        now: input.now,
      });

      buckets[verdict === 'FRESH' ? 'IN_SYNC' : verdict].push(ad.id);
    }

    return buckets;
  }
}

/**
 * Quantos degraus da escada já foram tentados, lidos de `driftDetails`.
 *
 * O contador mora no anúncio porque a escada é sobre **ele**. A execução tem o
 * seu próprio relógio (`ActionExecution.expiresAt`, §4.6): fundir os dois faria
 * o reaper de A2-S7 nunca disparar a tempo, que é o achado ⊕6.
 */
function attemptOf(ad: AdSyncSnapshot): number {
  const details = ad.driftDetails as { verificationAttempt?: number } | null;
  return Number(details?.verificationAttempt ?? 0);
}

function executionIdOf(ad: AdSyncSnapshot): string | null {
  const details = ad.driftDetails as { executionId?: string } | null;
  return details?.executionId ?? null;
}

function toLifecycle(
  status: AdStatus,
):
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'DELETED'
  | 'PENDING_REVIEW'
  | 'REJECTED' {
  switch (status) {
    case 'ACTIVE':
    case 'PAUSED':
    case 'ARCHIVED':
    case 'DELETED':
    case 'PENDING_REVIEW':
      return status;
    case 'DISAPPROVED':
      return 'REJECTED';
    default:
      // `UNKNOWN` não tem correspondente no vocabulário de evento. `PAUSED` é a
      // leitura conservadora: afirma "não está entregando", que é o que se sabe.
      return 'PAUSED';
  }
}
