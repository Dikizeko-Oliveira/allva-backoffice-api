import { JobCadence } from './sync-window';

/**
 * A tabela de agendamento de §8.8 como **dado**.
 *
 * *"A ordem é dado, não convenção. 'Após o ingest' não é executável enquanto for
 * uma palavra."* Cada job resolve a dependência consultando `JobRun`, e é este
 * mapa que diz de quem depender, sob que cadência e com que lease.
 *
 * **O lease é por tipo de job.** Ingest de 5k ads tem alvo de < 5 min (§17.2) e
 * cabe folgado em 30; um backfill de 400 dias de câmbio, não. Lease curto demais
 * faz um worker saudável perder a posse no meio do trabalho; longo demais deixa
 * a janela bloqueada até o dobro do tempo necessário quando um worker morre.
 */

export type JobScopeType =
  | 'AD_ACCOUNT'
  | 'ORGANIZATION'
  | 'INTEGRATION'
  | 'GLOBAL';

/**
 * Os jobs de §8.8 já entregues. Cada sprint acrescenta os seus, e a tabela
 * continua sendo **dado**: é ela que torna "após o ingest" executável em vez de
 * uma palavra num documento.
 */
export type SyncJobName =
  | 'ads-ingest'
  | 'ads-ingest-full'
  | 'ad-account-discovery'
  | 'ads-reconcile'
  | 'metrics-partition-maintenance'
  | 'ad-scoring'
  | 'waste-detection'
  | 'denormalization-reconcile'
  | 'recommendations-generation'
  | 'recommendation-lifecycle'
  | 'recommendation-outcome-measure'
  | 'action-execution-reaper'
  | 'data-retention';

export type JobDefinition = {
  name: SyncJobName;
  scopeType: JobScopeType;
  cadence: JobCadence;
  leaseMinutes: number;
  /** Job que precisa ter `SUCCEEDED` na janela antes deste rodar. */
  dependsOn?: SyncJobName;
};

export const SYNC_JOBS: Readonly<Record<SyncJobName, JobDefinition>> = {
  'ads-ingest': {
    name: 'ads-ingest',
    scopeType: 'AD_ACCOUNT',
    cadence: 'HOURLY',
    leaseMinutes: 30,
  },
  'ads-ingest-full': {
    name: 'ads-ingest-full',
    scopeType: 'AD_ACCOUNT',
    cadence: 'DAILY',
    leaseMinutes: 60,
  },
  'ad-account-discovery': {
    name: 'ad-account-discovery',
    scopeType: 'INTEGRATION',
    cadence: 'DAILY',
    leaseMinutes: 15,
  },
  'ads-reconcile': {
    name: 'ads-reconcile',
    scopeType: 'AD_ACCOUNT',
    cadence: 'HOURLY',
    leaseMinutes: 15,
  },
  'metrics-partition-maintenance': {
    name: 'metrics-partition-maintenance',
    scopeType: 'GLOBAL',
    cadence: 'MONTHLY',
    leaseMinutes: 15,
  },
  // A2-S4. **Depende de `ads-ingest-full` da mesma janela** (§8.8): pontuar
  // sobre uma ingestão que não terminou produz score sobre série incompleta, e a
  // queda que ele reporta é da leitura, não da mídia do usuário. A dependência é
  // resolvida por consulta a `JobRun`, nunca por horário.
  'ad-scoring': {
    name: 'ad-scoring',
    scopeType: 'AD_ACCOUNT',
    cadence: 'DAILY',
    leaseMinutes: 30,
    dependsOn: 'ads-ingest-full',
  },
  // A2-S5. Depende de `ad-scoring` da mesma janela (§8.8): quatro dos dez
  // detectores leem componentes do `AdScore`, e rodar antes deles produziria
  // `MISSING_SCORE` em massa — insuficiência fabricada pela ordem de execução,
  // não pelo dado.
  'waste-detection': {
    name: 'waste-detection',
    scopeType: 'AD_ACCOUNT',
    cadence: 'DAILY',
    leaseMinutes: 30,
    dependsOn: 'ad-scoring',
  },
  /**
   * C3 / §5.4 r.2 — as denormalizações são cache, e cache diverge.
   *
   * **Escopo de conta, não de organização como §8.8 declara.** A dependência é
   * resolvida por `JobRun` comparando `(jobName, scopeType, scopeId, windowKey)`,
   * e `waste-detection` é por conta: um job de organização não teria como
   * perguntar "todas as contas terminaram?" sem um mecanismo novo. Escopo de
   * conta torna a dependência declarada executável com o mecanismo que existe —
   * e resolver dependência por horário é exatamente o que §16.14 proíbe.
   */
  'denormalization-reconcile': {
    name: 'denormalization-reconcile',
    scopeType: 'AD_ACCOUNT',
    cadence: 'DAILY',
    leaseMinutes: 30,
    dependsOn: 'waste-detection',
  },
  /**
   * A2-S6. **Sem `dependsOn`, e isso é declaração, não esquecimento.**
   *
   * §8.8 diz que a geração depende de "`waste-detection` de **todas** as
   * contas", e o mecanismo de `JobRun` compara `(jobName, scopeType, scopeId,
   * windowKey)` — ele responde "esta conta terminou?", nunca "todas
   * terminaram?". O escopo aqui é a organização, e nenhum `scopeId` de conta
   * casaria.
   *
   * A guarda equivalente está no serviço, e é mais forte que a do cron: §9.4
   * passo 1 recusa gerar quando a organização não tem conta saudável. Uma conta
   * que ainda não detectou hoje simplesmente não contribui achados — e o ciclo
   * de amanhã a inclui, porque nada aqui é `SUCCEEDED` de uma vez só.
   */
  'recommendations-generation': {
    name: 'recommendations-generation',
    scopeType: 'ORGANIZATION',
    cadence: 'DAILY',
    leaseMinutes: 30,
  },
  /**
   * C5/⊕7 — **horário**, não diário.
   *
   * A reabilitação de uma diferida depende de a vencedora ter sido aplicada, e
   * isso acontece quando o usuário clica, não de madrugada. Esperar até o ciclo
   * seguinte deixaria o problema que ela descreve fora da tela por um dia
   * inteiro depois de o conflito já ter cessado.
   */
  'recommendation-lifecycle': {
    name: 'recommendation-lifecycle',
    scopeType: 'ORGANIZATION',
    cadence: 'HOURLY',
    leaseMinutes: 15,
  },
  /**
   * A2-S9 (C4) — a medição da janela pós.
   *
   * **Sem `dependsOn`, e por uma razão diferente da geração.** Medir não lê o
   * que o ingest de hoje trouxe: lê uma janela que fechou há dias, mais a janela
   * de re-declaração da conta (§8.9). Amarrá-la ao ingest da manhã faria a
   * medição de uma conta indisponível esperar indefinidamente por um dado que
   * ela já tem.
   *
   * Diária, escopo de organização: o volume é baixo — uma linha por recomendação
   * aplicada —, e a janela de um dia é irrelevante para um número que só existe
   * depois de duas ou três semanas.
   */
  'recommendation-outcome-measure': {
    name: 'recommendation-outcome-measure',
    scopeType: 'ORGANIZATION',
    cadence: 'DAILY',
    leaseMinutes: 30,
  },
  /**
   * A2-S9 (§14.6) — retenção.
   *
   * **Global e mensal, com lease longo.** `DROP PARTITION` é DDL: rápido, mas
   * exclusivo, e uma segunda réplica tentando o mesmo `DROP` no mesmo instante
   * produziria erro em vez de idempotência. Mensal porque a unidade da poda é a
   * partição, e partições são mensais — rodar diariamente faria 29 execuções por
   * mês descobrirem que não há nada a fazer.
   */
  'data-retention': {
    name: 'data-retention',
    scopeType: 'GLOBAL',
    cadence: 'MONTHLY',
    leaseMinutes: 30,
  },
  /**
   * A2-S7 (C2, ⊕6) — a varredura de `expiresAt`.
   *
   * **Global e a cada cinco minutos.** Global porque uma execução travada
   * segura o índice parcial de I2 e o alvo fica irrescrevível — e isso não é
   * problema de uma organização, é de qualquer uma; percorrer conta a conta
   * deixaria o tempo até a liberação depender de quantas contas existem.
   *
   * Cinco minutos contra um prazo de quinze: o pior caso é o alvo ficar preso
   * vinte minutos em vez de quinze. Uma cadência mais rala multiplicaria essa
   * cauda pelo mesmo fator, e o sintoma — "não consigo pausar este anúncio" —
   * não tem explicação visível para quem o vê.
   */
  'action-execution-reaper': {
    name: 'action-execution-reaper',
    scopeType: 'GLOBAL',
    cadence: 'FIVE_MINUTES',
    leaseMinutes: 4,
  },
};

/**
 * Vocabulário fechado de `skipReason` (§4.7).
 *
 * *"`SKIPPED` sem razão é tão opaco quanto não ter status."* Uma janela pulada
 * sem motivo é indistinguível de uma janela perdida, e a diferença entre as duas
 * é a diferença entre "o sistema decidiu" e "o sistema falhou".
 */
export type JobSkipReason =
  | 'NO_NEW_DATA'
  | 'EMPTY_WINDOW'
  | 'INTEGRATION_DISCONNECTED'
  | 'ACCOUNT_UNREACHABLE'
  | 'FEATURE_DISABLED'
  | 'UPSTREAM_NOT_READY'
  | 'CURRENCY_RECOMPUTING'
  | 'BUDGET_EXCEEDED';

export const JOB_SKIP_REASONS: readonly JobSkipReason[] = [
  'NO_NEW_DATA',
  'EMPTY_WINDOW',
  'INTEGRATION_DISCONNECTED',
  'ACCOUNT_UNREACHABLE',
  'FEATURE_DISABLED',
  'UPSTREAM_NOT_READY',
  'CURRENCY_RECOMPUTING',
  'BUDGET_EXCEEDED',
];

/**
 * O heartbeat roda a `lease/3`.
 *
 * Um terço dá duas batidas de folga antes de o lease vencer: com metade, um GC
 * pause ou uma consulta lenta já custaria a posse de um worker que está vivo e
 * trabalhando — e o takeover que se seguiria duplicaria o trabalho em vez de
 * recuperá-lo.
 */
export function heartbeatIntervalMs(leaseMinutes: number): number {
  return Math.max(5_000, Math.floor((leaseMinutes * 60_000) / 3));
}
