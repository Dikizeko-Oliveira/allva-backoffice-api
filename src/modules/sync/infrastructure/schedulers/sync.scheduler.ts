import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IntegrationsRepositoryInterface } from 'src/modules/integrations/domain/ports';
import { OrganizationSweepPolicyService } from 'src/modules/subscriptions/access/application/organization-sweep-policy.service';
import { createRootJobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { SCHEDULER_TIMEZONE } from 'src/shared/infrastructure/scheduling/scheduler-timezone';
import { ScheduleAuditService } from 'src/modules/sync/application/services/schedule-audit.service';
import { AdAccountsSyncRepositoryInterface } from 'src/modules/sync/domain/ports/ad-accounts-sync.repository';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { SyncDispatcher } from '../queues/sync.dispatcher';
import { isIngestHour } from 'src/modules/sync/domain/ingest-cadence';

/**
 * O cron de §8.8 — **rede de segurança permanente**, não fallback de emergência.
 *
 * A cadeia dirigida por evento é o caminho normal; este agendamento existe para
 * que nenhuma janela dependa de um evento ter sido entregue. É por isso que todo
 * job é idempotente por `(job, escopo, janela)`: uma execução agendada em cima
 * de uma execução por evento não pode processar a mesma janela duas vezes —
 * dobraria o custo de LLM (P9) e inflaria `occurrences`, que é sinal de P8.
 *
 * Cada tick apenas **enfileira**. O trabalho acontece no worker, sob lease.
 *
 * **Quem entra é decidido por `OrganizationSweepPolicyService`.** Organização
 * excluída não entra em nada. Organização sem acesso entra só na varredura
 * completa diária, e só pelas 48h seguintes ao fechamento.
 */
@Injectable()
export class SyncScheduler {
  private readonly logger = new Logger(SyncScheduler.name);

  constructor(
    private readonly accounts: AdAccountsSyncRepositoryInterface,
    private readonly integrations: IntegrationsRepositoryInterface,
    private readonly dispatcher: SyncDispatcher,
    private readonly env: EnvService,
    private readonly plans: PlanEntitlementService,
    private readonly scheduleAudit: ScheduleAuditService,
    private readonly sweep: OrganizationSweepPolicyService,
  ) {}

  /** ① incremental, horário. */
  @Cron('10 * * * *', { name: 'ads-ingest', timeZone: SCHEDULER_TIMEZONE })
  async ingestIncremental(): Promise<void> {
    if (!this.enabled()) return;

    const ctx = createRootJobContext();
    const now = new Date();

    /**
     * Só acesso aberto. Sem esta porta, a organização que parou de pagar caía
     * no intervalo de plano nulo — 1h — e sincronizava mais que um cliente
     * STARTER em dia.
     */
    const { kept: accounts, skipped: closedAccess } =
      await this.sweep.keepByMode(
        await this.accounts.listSyncable(),
        (account) => account.organizationId,
        ['FULL'],
        now,
      );

    /**
     * O intervalo é por organização, e várias contas de anúncios dividem a
     * mesma. Resolver por conta faria uma pergunta idêntica ao banco a cada
     * conta, de hora em hora — o cache local dura só este tick, que é
     * exatamente o tempo em que a resposta não muda.
     */
    const intervalByOrg = new Map<string, number>();
    let enqueued = 0;
    let deferred = 0;

    for (const account of accounts) {
      let interval = intervalByOrg.get(account.organizationId);

      if (interval === undefined) {
        interval = await this.plans.syncIntervalHoursFor(
          account.organizationId,
        );
        intervalByOrg.set(account.organizationId, interval);
      }

      // O cron é horário; planos com intervalo maior só entram nas horas certas.
      if (
        !isIngestHour({
          intervalHours: interval,
          now,
          timeZone: SCHEDULER_TIMEZONE,
        })
      ) {
        deferred += 1;
        continue;
      }

      /**
       * Conta que nunca completou uma varredura entra como **completa**, e a
       * decisão mora aqui e não no serviço.
       *
       * `IngestAdAccountService` já forçava varredura completa nesse caso, mas
       * tarde demais para o nome do job: o `JobRun` nasce na aquisição do lease
       * com o nome derivado deste parâmetro, então o ciclo fazia o trabalho
       * completo e registrava `ads-ingest`. Como `ad-scoring` exige
       * `ads-ingest-full` na mesma janela e no mesmo escopo, a cadeia de
       * inteligência ficava esperando a madrugada seguinte por um trabalho que
       * já tinha sido feito.
       */
      await this.dispatcher.ingest({
        ctx,
        adAccountId: account.id,
        trigger: 'SCHEDULE',
        forceFullScan: account.lastSuccessfulFullSyncAt === null,
      });
      enqueued += 1;
    }

    this.logger.log(
      `sync.ingest_enqueued contas=${enqueued} adiadas_por_plano=${deferred} ` +
        `fora_por_acesso=${closedAccess}`,
    );
  }

  /**
   * ① varredura completa, diária.
   *
   * É a única que autoriza arquivamento — e só ela pode: `updated_since` não
   * reporta remoção, então numa leitura incremental "não veio" significa apenas
   * "não mudou".
   *
   * **E é a única que a organização sem acesso ainda recebe**, pelas
   * `CLOSED_ACCESS_DAILY_SYNC_HOURS` seguintes ao fechamento: quem regulariza a
   * cobrança volta com o número de ontem, e não com o do dia em que ela falhou.
   */
  @Cron('20 3 * * *', {
    name: 'ads-ingest-full',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async ingestFull(): Promise<void> {
    if (!this.enabled()) return;

    const ctx = createRootJobContext();
    const { kept, skipped } = await this.sweep.keepByMode(
      await this.accounts.listSyncable(),
      (account) => account.organizationId,
      ['FULL', 'DAILY_SYNC_ONLY'],
    );

    for (const account of kept) {
      await this.dispatcher.ingest({
        ctx,
        adAccountId: account.id,
        trigger: 'SCHEDULE',
        forceFullScan: true,
      });
    }

    this.logger.log(
      `sync.ingest_full_enqueued contas=${kept.length} fora_por_acesso=${skipped}`,
    );
  }

  /** ④ reconciliação: 6/6h, mais a escada pós-escrita que S7 dispara. */
  @Cron('40 */6 * * *', {
    name: 'ads-reconcile',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async reconcile(): Promise<void> {
    if (!this.enabled()) return;

    const ctx = createRootJobContext();
    const { kept } = await this.sweep.keepByMode(
      await this.accounts.listSyncable(),
      (account) => account.organizationId,
      ['FULL'],
    );

    for (const account of kept) {
      await this.dispatcher.reconcile({ ctx, adAccountId: account.id });
    }
  }

  /**
   * Descoberta de contas, diária por integração.
   *
   * Só acesso aberto: a descoberta cria conta nova, e conta nova numa
   * organização sem acesso é sync e cota de plataforma para ninguém ver.
   */
  @Cron('0 4 * * *', {
    name: 'ad-account-discovery',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async discover(): Promise<void> {
    if (!this.enabled()) return;

    const ctx = createRootJobContext();
    const { kept } = await this.sweep.keepByMode(
      await this.integrations.listAllConnected(),
      (integration) => integration.organizationId,
      ['FULL'],
    );

    for (const integration of kept) {
      await this.dispatcher.discover({ ctx, integrationId: integration.id });
    }
  }

  /**
   * Manutenção de partições (C1, G4).
   *
   * Roda **todo dia**, não todo mês. §8.8 a lista como mensal, mas o custo de
   * uma verificação idempotente é uma consulta a `pg_class`, e o custo de perdê-
   * la uma vez é a ingestão inteira falhar na virada do mês. A idempotência é
   * garantida pelo lease mensal em `JobRun`: o tick diário só faz trabalho na
   * primeira vez que a janela do mês é adquirida.
   */
  @Cron('5 2 * * *', {
    name: 'metrics-partition-maintenance',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async maintainPartitions(): Promise<void> {
    await this.dispatcher.maintainPartitions({ ctx: createRootJobContext() });
  }

  /**
   * §14.6 — a retenção (A2-S9, entrega 7).
   *
   * **Tick diário, janela mensal**, pelo mesmo desenho da manutenção de
   * partições: o lease de `JobRun` faz o trabalho acontecer uma vez por mês, e
   * o tick diário garante que um dia de indisponibilidade não pule o mês
   * inteiro.
   *
   * **Depois da criação, nunca antes.** Criar as partições futuras às 02h05 e
   * podar as vencidas às 03h05 é a ordem que importa: invertida, uma falha da
   * poda que segurasse a janela adiaria a criação — e a manutenção que faltou é
   * a que quebra o ingest inteiro na virada do mês.
   */
  @Cron('5 3 * * *', {
    name: 'data-retention',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async applyRetention(): Promise<void> {
    await this.dispatcher.applyRetention({ ctx: createRootJobContext() });
  }

  /**
   * ⑦ auditoria do próprio agendamento — de hora em hora, no minuto 50.
   *
   * **Fora do `enabled()`.** As outras seis param quando `ADS_SYNC_ENABLED` é
   * `false`; esta não pode, porque a pergunta que ela responde — "as janelas
   * aconteceram?" — é justamente a que fica sem resposta quando algo está
   * desligado sem que ninguém tenha percebido.
   *
   * No minuto 50 para não disputar com o ingest do minuto 10 nem com o
   * lifecycle do 15: a auditoria lê o que eles escreveram, e ler no meio da
   * escrita reportaria como perdida uma janela que estava sendo preenchida.
   */
  @Cron('50 * * * *', {
    name: 'schedule-audit',
    timeZone: SCHEDULER_TIMEZONE,
  })
  async auditSchedule(): Promise<void> {
    await this.scheduleAudit.execute();
  }

  private enabled(): boolean {
    if (this.env.get('ADS_SYNC_ENABLED')) return true;

    this.logger.debug('sync.disabled ADS_SYNC_ENABLED=false');
    return false;
  }
}
