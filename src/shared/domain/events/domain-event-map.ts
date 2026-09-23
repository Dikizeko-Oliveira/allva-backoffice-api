/**
 * Os eventos de domínio da v2.0 (arquitetura §5.6), como **tipos com payload
 * obrigatório**.
 *
 * Eram 22 na tabela do documento. `sync.archive_suppressed` entrou em A2-S3 e
 * `denormalization.drift_detected` em A2-S5, os dois porque regras normativas
 * juntas não fechavam sem eles — cada justificativa está na declaração do
 * evento, junto do payload. **A lista não é livre:** um nome novo exige a mesma
 * justificativa registrada aqui, e o harness conta a lista.
 *
 * Regra normativa do documento: *"todo evento carrega os identificadores que
 * seus consumidores precisam para agir sem consultar outra fonte — o payload é
 * contrato, não conveniência"*. Um `Record<string, unknown>` aqui devolveria ao
 * consumidor o trabalho de adivinhar, e a primeira mudança de emissor quebraria
 * em produção, não em `tsc`.
 *
 * **`organizationId` não se repete no payload.** A tabela de §5.6 o lista como
 * payload mínimo de vários eventos; ele vive na envelope (`DomainEvent`), que
 * todo consumidor recebe inteira. Duplicá-lo criaria duas fontes de verdade
 * para o mesmo campo — e a divergência entre elas seria um vazamento entre
 * organizações, não um detalhe de serialização.
 *
 * Os literais de status abaixo são declarados aqui porque o schema v2.0 só
 * nasce em A2-S1. Quando os enums Prisma existirem, estes tipos passam a ser
 * derivados deles — a troca é de origem, não de valores.
 */

/**
 * Os treze tipos de ação, como literal do mapa de eventos.
 *
 * Declarado aqui e não importado de `ads` pela mesma razão dos status abaixo: o
 * mapa de eventos é `shared/domain` e não depende de módulo nenhum. Quando o
 * enum do Prisma for a fonte, os dois passam a derivar dele — a troca é de
 * origem, não de valores, e o harness de paridade cobra a igualdade.
 */
export type AdActionTypeName =
  | 'PAUSE_AD'
  | 'ENABLE_AD'
  | 'ARCHIVE_AD'
  | 'DUPLICATE_AD'
  | 'REPLACE_CREATIVE'
  | 'REPLACE_COPY'
  | 'REPLACE_CTA'
  | 'PAUSE_AD_SET'
  | 'ENABLE_AD_SET'
  | 'ADJUST_AD_SET_BUDGET'
  | 'PAUSE_CAMPAIGN'
  | 'ENABLE_CAMPAIGN'
  | 'ADJUST_CAMPAIGN_BUDGET';

/** Quem mexeu no status do anúncio (§5.6, `ad.status.changed`). */
export type AdStatusChangeSource =
  | 'ALLVA_ACTION'
  | 'EXTERNAL'
  | 'PLATFORM_RULE';

/** Estados de veiculação observados na plataforma. */
export type AdLifecycleStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'DELETED'
  | 'PENDING_REVIEW'
  | 'REJECTED';

/** §10.2 — desperdício e oportunidade são grandezas diferentes, nunca somadas. */
export type WasteFindingKind = 'WASTE' | 'OPPORTUNITY';

export type WastePriorityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

/**
 * §13 — de onde veio a ação. `USER_DIRECT` inclusive (P3).
 *
 * **Alinhado ao enum `AdActionOrigin` do schema em A2-S7.** Estes três tipos
 * nasceram como literais provisórios antes de A2-S1, com a nota de que
 * passariam a derivar dos enums quando eles existissem — e não passaram. O
 * schema chegou com outros nomes (`USER_DIRECT` no lugar de `MANUAL`,
 * `AUTOMATION_RULE` no lugar de `AUTOMATION`, `WASTE_RESOLUTION` que não
 * existia aqui), e a divergência só apareceu quando o primeiro emissor real
 * tentou publicar: até então nenhum código emitia `action.executed`, então
 * `tsc` não tinha o que comparar.
 *
 * Continuam declarados à mão de propósito: derivá-los de `@prisma/client` faria
 * `shared/domain` importar o ORM, que §16.6 proíbe. O que muda é que agora
 * **casam**, e um teste do harness cobra isso.
 */
export type AdActionOrigin =
  | 'RECOMMENDATION'
  | 'WASTE_RESOLUTION'
  | 'USER_DIRECT'
  | 'REVERT'
  | 'AUTOMATION_RULE';

/** Casa com o enum `ExecutionStatus` do schema. */
export type ActionExecutionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REJECTED_BY_PLATFORM'
  | 'UNSUPPORTED'
  | 'CANCELLED'
  /**
   * A plataforma criou a entidade e a sequência não terminou — ex.: o anúncio
   * duplicado existe e a pausa dele não foi confirmada. Não é `FAILED`: algo
   * mudou na mídia, e tratar como falha esconderia justamente o que exige ação.
   */
  | 'PARTIALLY_COMPLETED';

/**
 * §8.5 — resultado de um degrau da escada de verificação. Casa com o enum
 * `VerificationResult` do schema.
 */
export type VerificationResult =
  | 'CONFIRMED'
  | 'DIVERGED'
  | 'INCONCLUSIVE'
  | 'UNVERIFIED_WRITE';

/**
 * §9.7 — veredito da medição de impacto, nunca "causou".
 *
 * **Casa com o enum `OutcomeVerdict` do schema**, e não casava até A2-S9: a
 * redação anterior dizia `CONFIRMED | CONTRADICTED | ABANDONED`, que é
 * vocabulário de *verificação de escrita*, não de medição de desempenho. A
 * divergência sobreviveu três sprints pela mesma razão que a de A2-S8 — ninguém
 * emitia `recommendation.outcome.measured`, então `tsc` não tinha o que
 * comparar. Apareceu no primeiro emissor real, e o gate de paridade passou a
 * cobrir esta união também.
 *
 * `ABANDONED` saiu porque é **status**, não veredito: uma linha abandonada não
 * tem veredito nenhum, e é isso que a distingue de `INCONCLUSIVE` — nesta
 * alguém olhou e não deu para concluir.
 */
export type OutcomeVerdict =
  | 'IMPROVED'
  | 'UNCHANGED'
  | 'WORSENED'
  | 'INCONCLUSIVE';

/**
 * DEC-6/§9.7 — o delta primário declarado na geração da recomendação.
 *
 * **Casa com `OutcomeDeltaKind` do schema.** A redação anterior trazia
 * `SAVINGS | EFFICIENCY_GAIN | REVENUE_UPLIFT`, que é `ImpactType` — o tipo do
 * impacto **estimado** de §9.7. Os dois vocabulários existem e são diferentes:
 * o impacto responde "que espécie de ganho isto promete", o delta responde "que
 * grandeza a medição subtrai". Fundi-los faria o consumidor do evento ler
 * `SAVINGS` numa coluna que grava `SPEND_AVOIDED`.
 */
export type ObservedDeltaKind =
  | 'SPEND_AVOIDED'
  | 'REVENUE_DELTA'
  | 'SCORE_DELTA'
  | 'CPA_DELTA';

export type PlatformName = 'META' | 'GOOGLE' | 'TIKTOK';

/** Um intervalo de datas em `YYYY-MM-DD` — payload de evento é serializável. */
export type EventDateRange = { from: string; to: string };

/** As duas grandezas de §10.1, sempre em moeda original **e** moeda-base (R-M). */
export type EventMoney = {
  value: number;
  currency: string;
  valueBase: number;
  baseCurrency: string;
};

export type DomainEventMap = {
  // ─── sync ────────────────────────────────────────────────────────────────
  'ad.discovered': {
    adId: string;
    lineageId: string;
    adAccountId: string;
  };
  'ad.derived': {
    adId: string;
    lineageId: string;
    /** O anúncio de que este descende — a origem da linhagem (§3.6). */
    originAdId: string;
    /** A execução que o recriou; sem ela o outcome mede o anúncio errado. */
    originActionExecutionId: string;
  };
  'ad.metrics.updated': {
    adId: string;
    dateRange: EventDateRange;
    /** P9: sem mudança de digest, nenhum consumidor recomputa nada. */
    inputDigest: string;
  };
  'ad.status.changed': {
    adId: string;
    from: AdLifecycleStatus;
    to: AdLifecycleStatus;
    source: AdStatusChangeSource;
  };
  'ad.archived': {
    adId: string;
    lineageId: string;
    lastObservedAt: string;
  };
  'ad.drifted': {
    adId: string;
    expected: AdLifecycleStatus;
    observed: AdLifecycleStatus;
    driftCause: string;
  };
  'sync.quarantined': {
    adAccountId: string;
    externalAdId: string;
    reason: string;
  };
  /**
   * O 23º evento, e ele nasceu de duas regras que juntas não fechavam (A2-S3).
   *
   * O schema declara o tipo de alerta `AD_ARCHIVE_SUPPRESSED` (A5, ⊕1) e §5.3
   * r.7 declara `alerts` como **consumidor de evento puro** — zero injeção
   * direta por outros módulos. A tabela de §5.6 não tem nenhum evento que
   * carregue essa condição, então cumprir as duas regras ao mesmo tempo era
   * impossível: ou o `sync` chamaria `alerts` na mão, ou a guarda de §8.2
   * dispararia em silêncio. O alerta é sobre a **conta**, porque na hora em que
   * a guarda age não se sabe sequer quais anúncios teriam sido arquivados.
   */
  'sync.archive_suppressed': {
    adAccountId: string;
    /** `INCOMPLETE_RESPONSE` · `STEP_FAILED` · `ACCOUNT_NOT_HEALTHY`. */
    code: string;
    reason: string;
  };
  'action.verified': {
    adId: string;
    executionId: string;
    verificationResult: VerificationResult;
  };

  // ─── ad-scoring ──────────────────────────────────────────────────────────
  'ad.scored': {
    adId: string;
    adScoreId: string;
    aiScore: number;
    /** `null` quando a série não tem 7 dias comparáveis ou houve descontinuidade. */
    delta7d: number | null;
    algoVersion: string;
  };

  // ─── waste ───────────────────────────────────────────────────────────────
  'waste.detected': {
    adId: string;
    wasteItemId: string;
    type: string;
    kind: WasteFindingKind;
    /** §10.1: as duas grandezas viajam juntas — a incorrida e a evitável. */
    incurred: EventMoney;
    avoidableDaily: EventMoney;
    priority: WastePriorityLevel;
  };
  'waste.resolved': {
    adId: string;
    wasteItemId: string;
    /** `RESOLVED_BY_RESTATEMENT` é falso positivo, não acerto (§10.9). */
    resolutionKind: string;
  };
  /**
   * O 24º evento, e ele nasceu da mesma impossibilidade que o 23º (A2-S5).
   *
   * §10.8 manda o job `denormalization-reconcile` corrigir a divergência **e
   * emitir `DENORMALIZATION_DRIFT`**; o tipo de alerta existe no schema desde
   * A2-S1; e §5.3 r.7 declara `alerts` como consumidor de evento puro, sem
   * injeção direta por nenhum módulo. A tabela de §5.6 não tem evento que
   * carregue essa condição, então cumprir as três regras juntas era impossível:
   * ou `waste` chamaria `alerts` na mão, ou a correção aconteceria em silêncio —
   * e uma denormalização que precisa ser corrigida todo dia está errada todo dia
   * entre uma correção e a seguinte, que é precisamente o que §5.4 r.2 chama de
   * bug do worker.
   *
   * O sujeito é o **anúncio**: é a linha de `ads` cuja coluna divergiu, e é ela
   * que a tela lê.
   */
  'denormalization.drift_detected': {
    adId: string;
    adAccountId: string;
    /** Coluna divergente, ex.: `open_waste_amount_base`. */
    field: string;
    /** O que a denormalização dizia — já corrigido quando o evento sai. */
    stored: number;
    /** O que a agregação diz. A agregação é a verdade (§10.8). */
    actual: number;
  };

  // ─── recommendations ─────────────────────────────────────────────────────
  'recommendation.generated': {
    adId: string;
    recommendationId: string;
    kind: string;
    /** Vazio para as consultivas (`EXPAND_AUDIENCE`), que não têm ação. */
    actionIds: string[];
  };
  'recommendation.applied': {
    adId: string;
    recommendationId: string;
    executionIds: string[];
  };
  'recommendation.outcome.measured': {
    recommendationId: string;
    /** A medição é sobre a linhagem: recriar o anúncio não zera o resultado. */
    lineageId: string;
    observedDelta: number;
    /**
     * Sem o kind, o número é ininterpretável — economia e receita têm sinais e
     * unidades diferentes. DEC-6 o declara na geração; aqui ele só viaja.
     */
    observedDeltaKind: ObservedDeltaKind;
    verdict: OutcomeVerdict;
  };

  // ─── platform-actions ────────────────────────────────────────────────────
  'action.executed': {
    adId: string;
    actionId: string;
    executionId: string;
    origin: AdActionOrigin;
    status: ActionExecutionStatus;
    /** Preenchido pelas ações que recriam; é o que casa a linhagem no ingest. */
    resultPlatformEntityId?: string | null;
    /**
     * Só em `PARTIALLY_COMPLETED`: a entidade criada **pode estar veiculando**.
     * É o que separa o alerta crítico — gasto que ninguém confirmou — do aviso
     * de uma sequência que parou num estado seguro.
     */
    exposureRisk?: boolean;
    /**
     * O tipo da ação executada.
     *
     * Acrescentado com a geração de copy, e pela regra normativa deste arquivo:
     * *"todo evento carrega os identificadores que seus consumidores precisam
     * para agir sem consultar outra fonte"*. Sem ele, um consumidor que só se
     * interessa por `REPLACE_COPY` teria de ler `ad_actions` para descobrir se o
     * evento é dele — e um módulo de conteúdo passaria a consultar a tabela do
     * executor.
     */
    actionType: AdActionTypeName;
    /**
     * O **dígito** do texto que foi ao ar — nunca o texto.
     *
     * É o que permite a `creative-lab` casar a execução com a variação de copy
     * que a originou, sem que conteúdo de marca do cliente trafegue no
     * barramento de eventos. `platform-actions` já o calcula para a confirmação
     * de R14, então não há cálculo novo: o que muda é que ele deixa de morrer
     * dentro da guarda.
     *
     * Ausente em toda ação que não carrega texto.
     */
    appliedContentDigest?: string | null;
  };
  'action.reverted': {
    adId: string;
    actionId: string;
    revertedByActionId: string;
  };

  // ─── calibração ──────────────────────────────────────────────────────────
  'calibration.published':
    | {
        subject: 'ALGO';
        algoVersion: string;
        scope: string;
      }
    | {
        subject: 'DETECTOR';
        detectorVersion: string;
        scope: string;
      };

  // ─── integrations ────────────────────────────────────────────────────────
  'integration.disconnected': {
    integrationId: string;
    adAccountIds: string[];
  };
  'integration.rebound': {
    previousIntegrationId: string;
    integrationId: string;
    /** Contas religadas por `(organizationId, platform, externalAccountId)`. */
    reboundAdAccountIds: string[];
    /** As que a credencial nova não alcança — vão a `UNREACHABLE`, não arquivam. */
    unreachableAdAccountIds: string[];
  };
  'ad_account.discovered': {
    adAccountId: string;
    platform: PlatformName;
  };

  /**
   * O 25º evento: a conta acabou de completar a **primeira** varredura.
   *
   * Existe porque a cadeia de inteligência não podia ser chamada de dentro do
   * `sync`. `ad-scoring`, `waste` e `recommendations` já importam `SyncModule`
   * pelo lease de `JobRun`, então uma chamada na direção oposta fecharia ciclo
   * de módulo — e a alternativa que sobrava era esperar os crons da madrugada,
   * que é justamente o que fazia "conectei minha conta" e "recebi um
   * diagnóstico" ficarem separados por um dia inteiro.
   *
   * Só na primeira: dali em diante o ciclo diário basta, e reemitir a cada
   * varredura completa faria a cadeia inteira rodar de novo toda madrugada
   * sobre uma janela que já foi analisada.
   */
  'ad_account.first_sync_completed': {
    adAccountId: string;
    organizationId: string;
    platform: PlatformName;
  };

  // ─── organizations ────────────────────────────────────────────────────────
  /**
   * O 26º evento: a organização foi excluída.
   *
   * Existe pela mesma impossibilidade do 25º. Excluir a organização precisa
   * revogar as credenciais das plataformas — um token vivo de uma organização
   * que não existe mais é acesso a mídia paga sem dono, e o encerramento de
   * conta passa por aqui —, e quem sabe revogar é `integrations`. Só que
   * `integrations` importa `OrganizationsModule`, então a chamada na direção
   * oposta fecharia ciclo de módulo. O evento inverte a dependência:
   * `organizations` avisa, e quem guarda credencial reage.
   *
   * Emitido **depois** do commit da exclusão: revogação não tem volta, e um
   * token revogado por uma exclusão que a transação desfez deixaria uma
   * organização de pé sem acesso às próprias contas.
   */
  'organization.deleted': {
    /** Quem excluiu — a desconexão entra na trilha em nome dele. */
    actorId: string;
  };

  // ─── currency ────────────────────────────────────────────────────────────
  'organization.base_currency.change_requested': {
    from: string;
    to: string;
    migrationId: string;
  };
  'organization.base_currency.recomputed': {
    baseCurrency: string;
    migrationId: string;
    rowCounts: Record<string, number>;
  };
};

export type DomainEventName = keyof DomainEventMap;

/**
 * A versão vive na envelope, **nunca no nome** (§5.6.1).
 *
 * `ad.scored.v2` fragmentaria as assinaturas: um consumidor que só entende a v1
 * pararia de receber tudo, em vez de receber e ignorar o que não conhece.
 *
 * Regra de bump: **campo novo opcional não bumpa** — consumidores toleram campo
 * desconhecido. Remoção de campo, mudança de tipo ou de semântica **bumpa**.
 */
export const DOMAIN_EVENT_VERSIONS: Readonly<Record<DomainEventName, number>> =
  {
    'ad.discovered': 1,
    'ad.derived': 1,
    'ad.metrics.updated': 1,
    'ad.status.changed': 1,
    'ad.archived': 1,
    'ad.drifted': 1,
    'sync.quarantined': 1,
    'sync.archive_suppressed': 1,
    'action.verified': 1,
    'ad.scored': 1,
    'waste.detected': 1,
    'waste.resolved': 1,
    'denormalization.drift_detected': 1,
    'recommendation.generated': 1,
    'recommendation.applied': 1,
    'recommendation.outcome.measured': 1,
    'action.executed': 1,
    'action.reverted': 1,
    'calibration.published': 1,
    'integration.disconnected': 1,
    'integration.rebound': 1,
    'ad_account.discovered': 1,
    'ad_account.first_sync_completed': 1,
    'organization.deleted': 1,
    'organization.base_currency.change_requested': 1,
    'organization.base_currency.recomputed': 1,
  };

/** Os nomes em ordem estável — o harness de conformidade conta esta lista. */
export const DOMAIN_EVENT_NAMES = Object.keys(
  DOMAIN_EVENT_VERSIONS,
) as DomainEventName[];
