import type {
  ActionLevel,
  AdActionType,
  AdStatus,
} from 'src/modules/ads/domain/platform/platform-profile';
import type { AdActionParameters } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { AdActionOrigin } from 'src/shared/domain/events/domain-event-map';

export type ExecutionStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'REJECTED_BY_PLATFORM'
  | 'UNSUPPORTED'
  | 'CANCELLED'
  | 'PARTIALLY_COMPLETED';

export type EnqueueActionInput = {
  organizationId: string;
  adId: string;
  accountId: string;
  requestedByAccountId: string;
  actionType: AdActionType;
  level: ActionLevel;
  targetEntityType: ActionLevel;
  targetEntityId: string;
  parameters: AdActionParameters;
  origin: AdActionOrigin;
  recommendationId: string | null;
  /**
   * A `AdAction` **já persistida** que esta execução realiza (§9.5 passo 4).
   *
   * A geração de A2-S6 grava o plano como `AdAction` com `origin =
   * RECOMMENDATION` (P3); aplicar é executá-lo, não replanejá-lo. Criar uma
   * segunda ação aqui deixaria a recomendação com duas — uma proposta e uma
   * executada, indistinguíveis no schema — e a trilha de P5 passaria a contar o
   * dobro das ações que alguém de fato pediu.
   *
   * `null` no caminho direto, onde a intenção nasce com o pedido.
   */
  existingActionId: string | null;
  scopeWarning: string | null;
  reversible: boolean;
  /** Capturado **antes** da escrita — sem ele não há reversão (§13.5). */
  previousState: Record<string, unknown> | null;
  idempotencyKey: string;
  requestDigest: string;
  dryRun: boolean;
  correlationId: string | null;
  /** `appliedAt + 15 min`: mede a execução, nunca a verificação (C2, ⊕6). */
  expiresAt: Date;
  /**
   * O estado otimista a gravar no anúncio (§8.4). `null` quando a ação não muda
   * status de anúncio — orçamento não tem estado desejado no `Ad`.
   */
  desiredStatus: AdStatus | null;
};

/**
 * O que a transação de enfileiramento pode devolver.
 *
 * Os dois conflitos são **do banco**, não do código: os índices
 * `action_executions_inflight_unique` e `(organization_id, idempotency_key)` são
 * quem decide, e é por isso que a checagem prévia no use case não substitui
 * este retorno — entre a checagem e o `INSERT` cabe outra requisição.
 */
export type EnqueueResult =
  | { kind: 'ENQUEUED'; executionId: string; actionId: string }
  | { kind: 'WRITE_IN_FLIGHT'; inFlightExecutionId: string | null }
  | { kind: 'IDEMPOTENT_REPLAY'; executionId: string };

export type ActionExecutionView = {
  executionId: string;
  actionId: string;
  organizationId: string;
  adId: string;
  actionType: AdActionType;
  level: ActionLevel;
  targetEntityType: ActionLevel;
  targetEntityId: string;
  parameters: unknown;
  status: ExecutionStatus;
  attempt: number;
  dryRun: boolean;
  validationDepth: string | null;
  idempotencyKey: string;
  expiresAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultPlatformEntityId: string | null;
  verificationAttempt: number;
  verifiedAt: Date | null;
  verificationResult: string | null;
  /** Os dois estados de §8.4, **nunca fundidos**. */
  observedStatus: AdStatus;
  desiredStatus: AdStatus | null;
  createdAt: Date;
};

export abstract class ActionExecutionsRepositoryInterface {
  /**
   * Plano, execução e estado otimista **numa transação só** (§8.4).
   *
   * Gravar a `AdAction` e a `ActionExecution` em transações separadas produziria
   * ação órfã sempre que a segunda falhasse — e P3 verifica que toda ação tem
   * origem, não que toda ação tem execução. O buraco seria invisível.
   */
  abstract enqueue(input: EnqueueActionInput): Promise<EnqueueResult>;

  abstract findByIdempotencyKey(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<{ executionId: string; requestDigest: string } | null>;

  abstract findExecution(input: {
    organizationId: string;
    executionId: string;
  }): Promise<ActionExecutionView | null>;

  /**
   * Quantas execuções **reais** a organização disparou na janela.
   *
   * Dry-run não conta: ele não toca plataforma, e fazê-lo consumir teto puniria
   * exatamente a prática que o produto quer incentivar durante as duas semanas
   * de observação de RP5.
   */
  abstract countExecutionsSince(input: {
    organizationId: string;
    since: Date;
  }): Promise<number>;

  /**
   * Tudo que o worker precisa para escrever, numa consulta.
   *
   * Buscar em pedaços — execução, ação, anúncio, conta — abriria janela entre as
   * leituras: o kill switch pode ter sido desligado entre a primeira e a
   * terceira, e o worker escreveria com uma foto que já não existe.
   */
  abstract loadForExecution(
    executionId: string,
  ): Promise<ExecutableAction | null>;

  /**
   * `QUEUED → RUNNING`, e **só a partir de `QUEUED`**.
   *
   * Devolve `false` quando outra tentativa já a pegou. É a guarda que impede duas
   * réplicas do worker de escreverem a mesma ação: o Bull colapsa por `jobId`,
   * mas ids evictados voltam a ser aceitos, e I2 protege o alvo, não a execução.
   */
  abstract markRunning(input: {
    executionId: string;
    attempt: number;
  }): Promise<boolean>;

  /** Desfecho terminal da execução — libera I2 ao sair de QUEUED/RUNNING. */
  abstract settle(input: {
    executionId: string;
    status: Exclude<ExecutionStatus, 'QUEUED' | 'RUNNING'>;
    errorCode?: string | null;
    errorMessage?: string | null;
    responsePayload?: unknown;
    resultPlatformEntityId?: string | null;
    /**
     * Limpa o estado otimista do anúncio. A escrita não aconteceu, e deixar
     * `desiredStatus` preenchido faria a tela prometer "pausando…" para sempre.
     */
    clearDesiredStatus?: boolean;
  }): Promise<void>;

  /** Registra um degrau da escada (§13.4). */
  abstract recordVerification(input: {
    executionId: string;
    attempt: number;
    result: 'CONFIRMED' | 'DIVERGED' | 'INCONCLUSIVE' | 'UNVERIFIED_WRITE';
    verifiedAt: Date | null;
  }): Promise<void>;

  /**
   * A ação **inversa**, gravada como ação nova (§9.6).
   *
   * Transacional com o vínculo `revertedByActionId`: sem ele, a reversão
   * existiria como ação solta e a original continuaria dizendo que nunca foi
   * desfeita — e é a original que o outcome de P8 lê.
   */
  abstract enqueueRevert(input: {
    originalExecutionId: string;
    organizationId: string;
    requestedByAccountId: string;
    /** O tipo **inverso**: reverter um `PAUSE_AD` é um `ENABLE_AD` (§9.6). */
    actionType: AdActionType;
    parameters: AdActionParameters;
    previousState: Record<string, unknown> | null;
    idempotencyKey: string;
    requestDigest: string;
    correlationId: string | null;
    expiresAt: Date;
    desiredStatus: AdStatus | null;
  }): Promise<EnqueueResult>;

  /**
   * As execuções vencidas (C2, ⊕6): ainda em `QUEUED`/`RUNNING` com `expiresAt`
   * no passado.
   */
  abstract findExpired(input: { now: Date; limit: number }): Promise<
    Array<{
      executionId: string;
      organizationId: string;
      adId: string;
      attempt: number;
      status: ExecutionStatus;
      /** Uma recomendação em voo cuja execução venceu tem de sair de `APPLYING`. */
      recommendationId: string | null;
      requestedByAccountId: string | null;
    }>
  >;

  /**
   * O estado do plano inteiro de uma recomendação (§9.5 passo 5).
   *
   * Quem sabe se "todas SUCCEEDED" é quem é dono de `ActionExecution` — e é por
   * isso que a consulta mora aqui e não em `recommendations`. Uma recomendação
   * com três ações assenta quando a terceira assenta, e o único jeito de saber
   * qual é a terceira é contar as execuções.
   *
   * **Só as execuções reais contam.** Um dry-run sobre a mesma recomendação
   * marcaria o plano como executado sem nada ter sido escrito.
   */
  abstract planStatusFor(input: {
    organizationId: string;
    recommendationId: string;
  }): Promise<RecommendationPlanStatus>;
}

/** Contagem por desfecho das execuções de uma recomendação (§9.5 passo 5). */
export type RecommendationPlanStatus = {
  /** Ações do plano — inclusive as que ainda não têm execução real. */
  plannedActions: number;
  pending: number;
  succeeded: number;
  failed: number;
  executionIds: string[];
  /** A última execução a assentar; é ela que resolve os achados vinculados. */
  lastSettledExecutionId: string | null;
  settledAt: Date | null;
};

/** A foto completa que o worker recebe — uma consulta, um instante. */
export type ExecutableAction = {
  executionId: string;
  organizationId: string;
  actionId: string;
  adId: string;
  actionType: AdActionType;
  /**
   * P3 — a origem viaja com a ação até o evento. Assumi-la no worker faria
   * `action.executed` declarar `USER_DIRECT` para uma execução nascida de
   * recomendação, e o dataset de P8 perderia o vínculo que ele mede.
   */
  origin: AdActionOrigin;
  /** P3 — obrigatório quando `origin = RECOMMENDATION`; é o que fecha §9.5.5. */
  recommendationId: string | null;
  level: ActionLevel;
  targetEntityType: ActionLevel;
  /** Id do domínio — o de I2. */
  targetEntityId: string;
  /** Id na plataforma — o que o gateway usa. */
  targetExternalId: string;
  parameters: unknown;
  previousState: unknown;
  status: ExecutionStatus;
  attempt: number;
  dryRun: boolean;
  idempotencyKey: string;
  correlationId: string | null;
  expiresAt: Date;
  requestedByAccountId: string;
  desiredStatus: AdStatus | null;
  platform: string;
  integrationId: string;
  adAccountId: string;
  accountCurrency: string;
  externalAccountId: string;
  /** Lido **agora**: o kill switch precisa valer no instante da escrita. */
  organizationActionsEnabled: boolean;
  verificationAttempt: number;
};
