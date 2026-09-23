import { Injectable, Logger } from '@nestjs/common';
import { Integration } from 'src/modules/integrations/domain/entities';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { AdsProviderFactory } from 'src/modules/integrations/infrastructure/providers/ads-provider.factory';
import { RefreshIntegrationTokenUseCase } from 'src/modules/integrations/application/use-cases/refresh-integration-token.usecase';
import { AuditLogService } from 'src/modules/audit/application/audit-log.service';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { AdStructureRepositoryInterface } from 'src/modules/sync/domain/ports/ad-structure.repository';
import {
  SyncOperationsRepositoryInterface,
  SyncTrigger,
} from 'src/modules/sync/domain/ports/sync-operations.repository';
import {
  StepResult,
  evaluateArchiveGuard,
} from 'src/modules/sync/domain/archive-guard';
import {
  healthFromIngest,
  nextUnreachableSince,
  SyncHealthReason,
} from 'src/modules/sync/domain/account-health';
import { restatementWindowDaysFor } from 'src/modules/sync/domain/data-maturity';
import {
  ingestLookbackDaysFor,
  restatementWindow,
  shouldRunFullScan,
  updatedSinceFor,
} from 'src/modules/sync/domain/sync-window';
import { transitionSyncState } from 'src/modules/ads/domain/ad-sync-state';
import { PlatformRateLimiterService } from 'src/modules/platform-clients/infrastructure/platform-rate-limiter.service';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { MetricsIngestService } from './metrics-ingest.service';
import { PlatformBudgetService } from './platform-budget.service';
import { toProviderAdAccount } from './provider-ad-account';
import { StructureIngestService } from './structure-ingest.service';

export type IngestOutcome = {
  adAccountId: string;
  adsUpserted: number;
  metricRows: number;
  quarantined: number;
  archived: number;
  /** `false` ⇒ nenhum anúncio foi arquivado, por decisão declarada. */
  wasComplete: boolean;
  archiveSuppressedReason: string | null;
  health: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';
  /**
   * **Chamadas de plataforma gastas neste ciclo** (R4, A2-S9 entrega 9).
   *
   * A2-S8 adiou a chamada de reach de 7 dias porque *"a condição exige volume
   * medido de chamadas, e não há medição"*. Esta é a medição, no único lugar em
   * que ela significa alguma coisa: o ciclo que de fato consome o orçamento.
   * Sem ela, o custo de qualquer chamada nova continuaria sendo estimado — e
   * `call-budget.ts` seria um modelo sem nada contra o que ser conferido.
   *
   * `null` quando a conta não tem credencial: não houve ciclo a medir.
   */
  platformCalls: { granted: number; denied: number } | null;
};

/**
 * ① INGEST (§8.2) — os onze passos, na ordem, com a guarda no passo 9.
 *
 * **A guarda de arquivamento é a razão de este serviço existir na forma que
 * tem.** Cada etapa reporta o que conseguiu fazer, e é a soma desses relatos —
 * não a ausência de exceção — que decide se "não vimos este anúncio" pode
 * significar "ele não existe mais". Uma reconexão com escopo menor arquivaria
 * milhares de anúncios ativos, fecharia todo o desperdício aberto e zeraria o
 * número de capa sem que nada tivesse acontecido com a mídia.
 *
 * **Exclusão mútua.** §8.2 passo 1 pede lock advisory por `AdAccount`. Quem a
 * dá aqui é o lease de `JobRun` com o token de cerca (⊕14): é a mesma exclusão,
 * sobrevive à troca de conexão do pool (que um `pg_advisory_lock` de sessão não
 * garante com Prisma) e já carrega o fencing que a conclusão exige. Dois
 * mecanismos para a mesma exclusão mútua é como ela deixa de existir — o próprio
 * documento diz isso sobre `JobRun` × I2.
 */
@Injectable()
export class IngestAdAccountService {
  private readonly logger = new Logger(IngestAdAccountService.name);

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly structure: AdStructureRepositoryInterface,
    private readonly operations: SyncOperationsRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly providers: AdsProviderFactory,
    private readonly refreshToken: RefreshIntegrationTokenUseCase,
    private readonly audit: AuditLogService,
    private readonly structureIngest: StructureIngestService,
    private readonly metricsIngest: MetricsIngestService,
    private readonly budget: PlatformBudgetService,
    private readonly events: DomainEventBus,
    private readonly rateLimiter: PlatformRateLimiterService,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    adAccountId: string;
    trigger: SyncTrigger;
    ctx: JobContext;
    now?: Date;
    forceFullScan?: boolean;
  }): Promise<IngestOutcome> {
    const now = input.now ?? new Date();
    const account = await this.accounts.findById(input.adAccountId);

    if (!account) {
      throw new Error(`AdAccount ${input.adAccountId} não encontrada`);
    }

    const emit = { ...input.ctx, organizationId: account.organizationId };
    const steps: StepResult[] = [];

    // ── 2. credencial ────────────────────────────────────────────────────────
    const credential = await this.resolveCredential(account.integrationId);
    if (!credential.integration) {
      steps.push({
        step: 'CREDENTIAL',
        status: 'FAILED',
        reason: credential.reason,
      });
      await this.applyHealth(account, {
        wasComplete: false,
        failedSteps: ['CREDENTIAL'],
        accessFailure: credential.reason,
        now,
      });

      return {
        adAccountId: account.id,
        adsUpserted: 0,
        metricRows: 0,
        quarantined: 0,
        archived: 0,
        wasComplete: false,
        platformCalls: null,
        archiveSuppressedReason: 'credencial indisponível',
        health: 'UNREACHABLE',
      };
    }
    steps.push({ step: 'CREDENTIAL', status: 'SUCCEEDED' });

    const integration = credential.integration;
    const profile = platformProfile(account.platform);

    // ── janela de re-declaração, por CONTA (§8.2) ────────────────────────────
    const restatementDays = restatementWindowDaysFor({
      attributionWindowDays: account.attributionWindowDays,
      envMinimumDays: this.env.get('ADS_SYNC_LOOKBACK_DAYS'),
    });
    if (restatementDays !== account.restatementWindowDays) {
      await this.accounts.updateRestatementWindow(account.id, {
        attributionWindowDays: account.attributionWindowDays,
        restatementWindowDays: restatementDays,
      });
    }
    // A janela de re-declaração é a política permanente da conta e continua
    // sendo o que `SyncOperation` registra. O que se LÊ desta vez pode ser mais
    // largo: no primeiro ingest, ler só 7 dias entregaria zero dias `MATURE` e o
    // produto ficaria mudo por ~12 dias — para quem paga e para quem testa.
    // Lido **antes** de `applyHealth` mover o carimbo: depois dele a conta já
    // não parece estreante, e é essa a diferença que decide se a cadeia de
    // inteligência é acordada agora ou espera o ciclo diário.
    const isFirstIngest = account.lastSuccessfulFullSyncAt === null;

    const lookbackDays = ingestLookbackDaysFor({
      isFirstIngest,
      restatementDays,
      backfillDays: this.env.get('ADS_SYNC_BACKFILL_DAYS'),
      maxLookbackDays: this.env.get('ADS_SYNC_MAX_LOOKBACK_DAYS'),
    });
    const window = restatementWindow(now, lookbackDays);

    if (lookbackDays !== restatementDays) {
      this.logger.log(
        `sync.backfill contaAnuncios=${account.id} dias=${lookbackDays} ` +
          `(janela de re-declaração=${restatementDays})`,
      );
    }

    const fullScan =
      input.forceFullScan ??
      shouldRunFullScan({
        lastSuccessfulFullSyncAt: account.lastSuccessfulFullSyncAt,
        supportsUpdatedSince: profile.sync.supportsUpdatedSince,
        now,
      });

    // ── 3. abre a SyncOperation ──────────────────────────────────────────────
    const operation = await this.operations.open({
      organizationId: account.organizationId,
      integrationId: integration.id,
      adAccountId: account.id,
      direction: 'INBOUND',
      kind: fullScan ? 'FULL_ACCOUNT' : 'STRUCTURE_ONLY',
      trigger: input.trigger,
      windowStart: window.since,
      windowEnd: window.until,
      restatementWindowDays: restatementDays,
    });

    // ── 4–6. leitura da plataforma ───────────────────────────────────────────
    const provider = this.providers.for(account.platform);
    const result = await this.budget.spend(integration.id, () =>
      provider.syncAdAccountMetrics(
        toProviderAdAccount(account, integration),
        integration,
        { since: window.since, until: window.until },
        {
          levels: ['AD', 'CREATIVE'],
          updatedSince: updatedSinceFor({
            lastStructureSyncAt: account.lastFullSyncAt,
            fullScan,
          }),
        },
      ),
    );

    for (const failure of result.stepFailures ?? []) {
      steps.push({
        step: failure.step === 'INSIGHTS' ? 'METRICS' : 'STRUCTURE',
        status: 'FAILED',
        reason: `${failure.message}${failure.status ? ` (HTTP ${failure.status})` : ''}`,
      });
    }
    if (!steps.some((step) => step.step === 'STRUCTURE')) {
      steps.push({
        step: 'STRUCTURE',
        status: 'SUCCEEDED',
        count: result.ads?.length ?? 0,
      });
    }

    if (result.checkpoints) {
      await this.operations.saveCheckpoint(operation.id, result.checkpoints);
    }

    // ── 5. upsert em ordem de FK + quarentena ────────────────────────────────
    const structure = await this.structureIngest.apply({
      account,
      integrationId: integration.id,
      campaigns: result.campaigns,
      adSets: result.adSets ?? [],
      ads: result.ads ?? [],
      creatives: result.creatives ?? [],
      fullScan,
      syncStartedAt: operation.startedAt,
      now,
    });
    steps.push({
      step: 'UPSERT',
      status: 'SUCCEEDED',
      count: structure.adsUpserted,
    });

    // ── 6–7. métricas em nível AD + normalização monetária ───────────────────
    const metrics = await this.metricsIngest.apply({
      account,
      rows: result.metrics,
      window,
      adIdByExternalId: structure.adIdByExternalId,
      campaignIdByExternalId: await this.structure.mapCampaignIds(account.id),
      adSetIdByExternalId: await this.structure.mapAdSetIds(account.id),
      creativeIdByExternalId: await this.structure.mapCreativeIds(account.id),
      attributionSetting: null,
      now,
    });
    if (!steps.some((step) => step.step === 'METRICS')) {
      steps.push({ step: 'METRICS', status: 'SUCCEEDED', count: metrics.rows });
    }
    steps.push({
      step: 'NORMALIZATION',
      status: 'SUCCEEDED',
      count: metrics.pendingNormalization,
    });
    steps.push({ step: 'OBSERVED_STATUS', status: 'SUCCEEDED' });

    // ── saúde da conta, e só então o veredito de arquivamento ────────────────
    const health = await this.applyHealth(account, {
      wasComplete: result.wasComplete,
      failedSteps: steps
        .filter((step) => step.status === 'FAILED')
        .map((step) => step.step),
      accessFailure: null,
      now,
      fullScan,
    });

    /**
     * A conta acabou de ganhar a **primeira** varredura completa.
     *
     * `isFirstIngest` foi lido no início deste ciclo, antes de `applyHealth`
     * mover `lastSuccessfulFullSyncAt` — então é aqui, e só aqui, que dá para
     * saber que esta é a estreia. O evento existe porque a cadeia de
     * inteligência não pode ser chamada daqui sem fechar ciclo de módulo, e
     * esperar o cron da madrugada é o que separava "conectei" de "recebi um
     * diagnóstico" por um dia inteiro.
     */
    if (isFirstIngest && fullScan && health === 'HEALTHY') {
      this.events.emitFrom(emit, 'ad_account.first_sync_completed', {
        adAccountId: account.id,
        organizationId: account.organizationId,
        platform: account.platform as never,
      });
    }

    // ── 9. ARQUIVAMENTO — a correção central de §8.2 ─────────────────────────
    const verdict = evaluateArchiveGuard({
      wasComplete: result.wasComplete,
      stepResults: steps,
      health,
    });

    let archived = 0;
    let archiveSuppressedReason: string | null = null;

    if (verdict.allowed && fullScan) {
      const archivedAds = await this.structure.archiveAdsNotSeen({
        adAccountId: account.id,
        seenExternalAdIds: structure.seenExternalAdIds,
        archivedAt: now,
      });
      archived = archivedAds.length;

      for (const ad of archivedAds) {
        this.events.emitFrom(emit, 'ad.archived', {
          adId: ad.id,
          lineageId: ad.lineageId,
          lastObservedAt: (ad.observedAsOf ?? now).toISOString(),
        });
      }
      steps.push({ step: 'ARCHIVE', status: 'SUCCEEDED', count: archived });
    } else if (!verdict.allowed) {
      archiveSuppressedReason = verdict.reason;
      steps.push({
        step: 'ARCHIVE',
        status: 'SKIPPED',
        reason: `${verdict.code}: ${verdict.reason}`,
      });
      this.logger.warn(
        `sync.archive_suppressed adAccountId=${account.id} code=${verdict.code} — ${verdict.reason}`,
      );
      // Uma guarda silenciosa é indistinguível de um bug que esqueceu de
      // arquivar. O evento é o que faz `alerts` levantar
      // `AD_ARCHIVE_SUPPRESSED` sobre a **conta** sem que o `sync` precise
      // chamar `alerts` na mão (§5.3 r.7).
      this.events.emitFrom(emit, 'sync.archive_suppressed', {
        adAccountId: account.id,
        code: verdict.code,
        reason: verdict.reason,
      });
    } else {
      // Varredura incremental nunca arquiva: `updated_since` não reporta
      // remoção, então "não veio nesta resposta" só diz que não mudou.
      steps.push({
        step: 'ARCHIVE',
        status: 'SKIPPED',
        reason: 'varredura incremental não decide sobre ausência',
      });
    }

    // ── 10. eventos ──────────────────────────────────────────────────────────
    for (const discovered of structure.discovered) {
      this.events.emitFrom(emit, 'ad.discovered', {
        adId: discovered.id,
        lineageId: discovered.lineageId,
        adAccountId: account.id,
      });
    }

    for (const adId of metrics.touchedAdIds) {
      this.events.emitFrom(emit, 'ad.metrics.updated', {
        adId,
        dateRange: {
          from: window.since.toISOString().slice(0, 10),
          to: window.until.toISOString().slice(0, 10),
        },
        inputDigest: metrics.inputDigestByAd.get(adId) ?? '',
      });
    }

    for (const change of structure.statusChanges) {
      this.events.emitFrom(emit, 'ad.status.changed', {
        adId: change.adId,
        from: toLifecycle(change.from),
        to: toLifecycle(change.to),
        // Uma mudança observada com intenção nossa em voo é assunto da
        // reconciliação (§8.5a), não uma alteração externa. Marcá-la como
        // externa faria a própria escrita da Allva aparecer para o usuário como
        // "alguém mexeu no seu anúncio".
        source: change.hadDesiredStatus ? 'ALLVA_ACTION' : 'EXTERNAL',
      });

      // A causa provável não cabe no payload de §5.6 e não vai inventar campo:
      // "mudou" sem causa é um alerta que ninguém sabe o que fazer com, e o log
      // é onde quem investiga encontra a diferença entre uma reprovação da
      // plataforma e um operador que pausou o anúncio.
      if (change.externalCause) {
        this.logger.log(
          `ad.status.changed_external adId=${change.adId} ` +
            `${change.from}→${change.to} causa=${change.externalCause}`,
        );
      }
    }

    if (structure.quarantined > 0) {
      this.events.emitFrom(emit, 'sync.quarantined', {
        adAccountId: account.id,
        externalAdId: `${structure.quarantined} anúncios`,
        reason: 'pai não resolvível nesta leitura',
      });
    }

    // Anúncios vistos e íntegros voltam a `IN_SYNC` pela máquina de I4 — nunca
    // por atribuição direta.
    const inSyncIds = [...structure.adIdByExternalId.values()];
    if (inSyncIds.length > 0 && health === 'HEALTHY') {
      await this.structure.applySyncState({
        adIds: inSyncIds,
        syncState: transitionSyncState({
          from: 'STALE',
          to: 'IN_SYNC',
          actor: 'sync',
        }),
        syncStateAt: now,
      });
    }

    // ── auditoria: o vocabulário de sync (deliverable 16) ────────────────────
    //
    // Só a varredura **completa** entra na trilha, e por decisão: o incremental
    // roda de hora em hora por conta, e registrá-lo faria a auditoria crescer
    // ~24 linhas por conta por dia sem responder nada que `SyncOperation` já não
    // responda melhor. A completa é a que decide o que existe — é ela que a
    // pergunta "por que este anúncio sumiu da minha tela?" precisa alcançar.
    if (fullScan) {
      await this.audit.record({
        event: 'sync.completed',
        entityType: 'ad_account',
        entityId: account.id,
        organizationId: account.organizationId,
        metadata: {
          wasComplete: result.wasComplete,
          adsUpserted: structure.adsUpserted,
          metricRows: metrics.rows,
          archived,
          archiveSuppressedReason,
          health,
        },
      });
    }

    if (structure.quarantined > 0) {
      await this.audit.record({
        event: 'sync.quarantined',
        entityType: 'ad_account',
        entityId: account.id,
        organizationId: account.organizationId,
        metadata: { items: structure.quarantined },
      });
    }

    // ── 11. fecha a SyncOperation ────────────────────────────────────────────
    await this.operations.close(operation.id, {
      status: result.wasComplete ? 'SUCCEEDED' : 'PARTIAL',
      entitiesRead: (result.ads?.length ?? 0) + result.metrics.length,
      entitiesWritten: structure.adsUpserted + metrics.rows,
      wasComplete: result.wasComplete,
      stepResults: steps,
      errorCode: result.wasComplete ? null : 'INCOMPLETE_RESPONSE',
      errorMessage: archiveSuppressedReason,
    });

    return {
      adAccountId: account.id,
      adsUpserted: structure.adsUpserted,
      metricRows: metrics.rows,
      quarantined: structure.quarantined,
      archived,
      wasComplete: result.wasComplete,
      platformCalls: this.callsSpent(account.integrationId),
      archiveSuppressedReason,
      health,
    };
  }

  /**
   * Resolve a credencial corrente, renovando o token quando está por vencer.
   *
   * Conta sem `integrationId` é estado **legítimo** depois de um disconnect
   * (P10: a identidade sobrevive à credencial) — vira `UNREACHABLE`, e não erro.
   */
  /**
   * O que o balde de R4 concedeu e recusou a esta integração.
   *
   * **Acumulado do processo, não do ciclo** — o contador não é zerado entre
   * execuções, de propósito: zerá-lo aqui daria a cada ciclo a impressão de
   * começar do zero, e o que interessa a R4 é o consumo agregado contra um
   * limite que a plataforma também mede agregado. A diferença entre duas
   * leituras consecutivas é o custo do ciclo, e ela é derivável; o contrário
   * não é.
   */
  private callsSpent(
    integrationId: string | null,
  ): { granted: number; denied: number } | null {
    if (!integrationId) return null;

    const accounting = this.rateLimiter.accountingFor(integrationId);
    if (!accounting) return null;

    return { granted: accounting.granted, denied: accounting.denied };
  }

  private async resolveCredential(integrationId: string | null): Promise<{
    integration: Integration | null;
    reason: SyncHealthReason;
  }> {
    if (!integrationId) {
      return { integration: null, reason: 'CREDENTIAL_MISSING' };
    }

    const integration = await this.integrations.findById(integrationId);
    if (!integration) {
      return { integration: null, reason: 'CREDENTIAL_MISSING' };
    }

    const expiresAt = integration.expiresAt;
    const expiringSoon =
      expiresAt !== null &&
      expiresAt !== undefined &&
      expiresAt.getTime() - Date.now() < 15 * 60_000;

    if (!expiringSoon) return { integration, reason: 'RECOVERED' };

    try {
      const refreshed =
        await this.refreshToken.executeForIntegration(integration);
      return { integration: refreshed, reason: 'RECOVERED' };
    } catch {
      return { integration: null, reason: 'CREDENTIAL_EXPIRED' };
    }
  }

  private async applyHealth(
    account: {
      id: string;
      syncHealth: 'HEALTHY' | 'DEGRADED' | 'UNREACHABLE';
      unreachableSince: Date | null;
    },
    input: {
      wasComplete: boolean;
      failedSteps: string[];
      accessFailure: SyncHealthReason | null;
      now: Date;
      fullScan?: boolean;
    },
  ) {
    const verdict = healthFromIngest({
      wasComplete: input.wasComplete,
      failedSteps: input.failedSteps,
      accessFailure: input.accessFailure,
    });

    await this.accounts.updateHealth(account.id, {
      health: verdict.health,
      reason: verdict.reason,
      unreachableSince: nextUnreachableSince({
        current: account.unreachableSince,
        previousHealth: account.syncHealth,
        nextHealth: verdict.health,
        now: input.now,
      }),
      // `lastSuccessfulFullSyncAt` só avança quando a varredura foi **completa**:
      // é ele que decide quando a próxima varredura completa acontece, e movê-lo
      // depois de uma leitura truncada adiaria por 24h a chance de ver o que
      // faltou.
      lastSuccessfulFullSyncAt:
        input.fullScan && verdict.health === 'HEALTHY' ? input.now : undefined,
      lastFullSyncAt: input.fullScan ? input.now : undefined,
    });

    return verdict.health;
  }
}

/** `AdStatus` do domínio → o vocabulário de ciclo de vida dos eventos (§5.6). */
function toLifecycle(
  status: string,
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
      // leitura conservadora: diz "não está entregando", que é o que sabemos.
      return 'PAUSED';
  }
}
