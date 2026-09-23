import { Injectable, Logger } from '@nestjs/common';
import { isBudgetAction } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { ActionParametersOf } from 'src/modules/ads/domain/actions/action-parameters.schema';
import { tiktokDeliveryStatus } from 'src/modules/ads/domain/platform/delivery-status';
import type {
  ActionLevel,
  AdActionType,
} from 'src/modules/ads/domain/platform/platform-profile';
import {
  checkCopyLength,
  toCanonicalStatus,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  PlatformHttpClient,
  PlatformRequestError,
} from 'src/modules/platform-clients/infrastructure/platform-http.client';
import type {
  AdActionCapability,
  AdActionCommand,
  AdActionResult,
  ExecutionContext,
  ObservedEntityState,
  ValidationFailure,
  ValidationResult,
} from 'src/modules/platform-actions/domain/contracts/action-contracts';
import { AdActionGateway } from 'src/modules/platform-actions/domain/ports/ad-action.gateway';
import { fromMinorUnits, toMinorUnits } from 'src/shared/domain/money';

const TIKTOK_API = 'https://business-api.tiktok.com/open_api/v1.3';

/** Tentativas de confirmar a pausa de um anúncio recém-criado. */
const PAUSE_ATTEMPTS = 3;
const PAUSE_RETRY_DELAY_MS = 1_000;

/**
 * O gateway de escrita do TikTok (§13.2, entrega 4 de A2-S8).
 *
 * **A diferença que decide o desenho deste arquivo: o TikTok responde `HTTP 200`
 * mesmo quando recusa.** O erro vem no corpo, em `code != 0`. `PlatformHttpClient`
 * classifica por status HTTP — é o que serve para Meta e Google — e aqui isso
 * não basta: uma escrita recusada chegaria como sucesso, a execução seria
 * gravada `SUCCEEDED`, a escada de verificação confirmaria o estado antigo como
 * divergência, e ninguém saberia que a plataforma disse não.
 *
 * Por isso **toda** resposta passa por `readEnvelope` antes de virar resultado.
 *
 * Duas outras diferenças: o orçamento vai como número na moeda da conta — sem
 * micros e sem unidade menor —, e o **tipo** do orçamento é fixado na criação
 * (`budget_mode`). Gravar um valor "diário" num objeto com orçamento total
 * mudaria o teto do voo inteiro com a mesma chamada, e a API aceitaria.
 *
 * ## Criar anúncio: a operação que pode aumentar gasto
 *
 * Duplicar e trocar texto ou CTA **criam** anúncio (não há cópia nem edição de
 * texto por chamada única). E o TikTok não garante criação pausada: o padrão de
 * `operation_status` na criação é `ENABLE`. A regra deste arquivo é que **uma
 * ação da Allva nunca aumenta gasto em silêncio**:
 *
 * - a criação pede `DISABLE`, e a pausa é **confirmada relendo** o anúncio — a
 *   resposta da criação não basta;
 * - sem confirmação depois das tentativas, o desfecho é `PARTIALLY_COMPLETED`
 *   com `exposureRisk`, que vira alerta crítico — nunca `SUCCEEDED`, nunca um
 *   `FAILED` que esconderia a entidade criada;
 * - criação nunca volta à fila: repetir criaria outro anúncio.
 */
@Injectable()
export class TikTokAdActionGateway extends AdActionGateway {
  readonly platform: Platform = 'TIKTOK';

  private readonly logger = new Logger(TikTokAdActionGateway.name);

  /** A espera entre tentativas de pausa — substituível em teste. */
  protected wait = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

  constructor(private readonly http: PlatformHttpClient) {
    super();
  }

  capabilities(): AdActionCapability[] {
    return CAPABILITIES;
  }

  validate(cmd: AdActionCommand): Promise<ValidationResult> {
    const failures: ValidationFailure[] = [];
    const capability = this.capabilityFor(cmd.type);

    if (!capability.supported) {
      failures.push({
        code: 'ACTION_UNSUPPORTED',
        message:
          capability.unsupportedReason ?? 'Ação não suportada no TikTok.',
      });
    }

    if (!cmd.target.externalId) {
      failures.push({
        code: 'TARGET_NOT_RESOLVED',
        message: 'O alvo não tem id na plataforma.',
        field: 'target.externalId',
      });
    }

    if (cmd.type === 'REPLACE_COPY' || cmd.type === 'REPLACE_CTA') {
      const refusal = textRefusal(cmd);
      if (refusal) {
        failures.push({
          code: refusal.errorCode ?? 'COPY_INVALID',
          message: refusal.errorMessage ?? 'Texto inválido.',
          field: 'parameters',
        });
      }
    }

    if (isBudgetAction(cmd.type)) {
      const parameters =
        cmd.parameters as ActionParametersOf<'ADJUST_AD_SET_BUDGET'>;

      if (parameters.currency !== cmd.accountCurrency) {
        failures.push({
          code: 'CURRENCY_MISMATCH',
          message: `O orçamento veio em ${parameters.currency} e a conta opera em ${cmd.accountCurrency}.`,
          field: 'parameters.currency',
        });
      }

      if (!(parameters.dailyBudget > 0)) {
        failures.push({
          code: 'BUDGET_NOT_POSITIVE',
          message: 'Orçamento precisa ser maior que zero.',
          field: 'parameters.dailyBudget',
        });
      }
    }

    return Promise.resolve({
      valid: failures.length === 0,
      depth: 'LOCAL_ONLY',
      failures,
    });
  }

  async execute(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const capability = this.capabilityFor(cmd.type);

    if (!capability.supported) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'ACTION_UNSUPPORTED',
        errorMessage: capability.unsupportedReason,
        retryable: false,
      };
    }

    if (cmd.type === 'DUPLICATE_AD') return this.duplicate(cmd, ctx);

    if (cmd.type === 'REPLACE_COPY' || cmd.type === 'REPLACE_CTA') {
      return this.replaceText(cmd, ctx);
    }

    const operation = OPERATION_BY_ACTION[cmd.type];

    if (operation) {
      return this.updateStatus(cmd, ctx, operation);
    }

    if (isBudgetAction(cmd.type)) {
      const parameters =
        cmd.parameters as ActionParametersOf<'ADJUST_AD_SET_BUDGET'>;

      return this.updateDailyBudget(cmd, ctx, parameters.dailyBudget);
    }

    return {
      status: 'UNSUPPORTED',
      errorCode: 'PARAMETERS_UNSUPPORTED',
      errorMessage: `${cmd.type} não tem tradução para uma chamada do TikTok.`,
      retryable: false,
    };
  }

  async revert(
    cmd: AdActionCommand,
    previousState: unknown,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const previous = previousState as ObservedEntityState | null;

    if (!previous?.status && !previous?.dailyBudgetMinor) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'PREVIOUS_STATE_MISSING',
        errorMessage: 'Não há estado anterior capturado para reverter.',
        retryable: false,
      };
    }

    const own = ownStatusOf(previous);

    /**
     * `DELETE` e `FROZEN` são terminais no TikTok como `REMOVED` é no Google. A
     * recusa aqui é a segunda linha — `inverseActionOf` já barra `ARCHIVE_AD`
     * antes.
     */
    if (
      TERMINAL_STATUSES.has(own ?? '') ||
      TERMINAL_STATUSES.has(previous.status ?? '')
    ) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'IRREVERSIBLE_STATE',
        errorMessage:
          'Um objeto excluído ou encerrado no TikTok não volta por escrita.',
        retryable: false,
      };
    }

    if (OPERATION_BY_ACTION[cmd.type]) {
      if (!own) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'PREVIOUS_STATE_INCOMPLETE',
          errorMessage: 'O estado anterior não registrou o status do alvo.',
          retryable: false,
        };
      }

      return this.updateStatus(
        cmd,
        ctx,
        own === 'ENABLE' ? 'ENABLE' : 'DISABLE',
      );
    }

    if (isBudgetAction(cmd.type)) {
      const amount = fromMinorUnits(
        previous.dailyBudgetMinor,
        cmd.accountCurrency,
      );

      if (amount === null || amount <= 0) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'PREVIOUS_STATE_INCOMPLETE',
          errorMessage: 'O estado anterior não registrou o orçamento diário.',
          retryable: false,
        };
      }

      return this.updateDailyBudget(cmd, ctx, amount);
    }

    return {
      status: 'UNSUPPORTED',
      errorCode: 'REVERT_UNSUPPORTED',
      errorMessage: `Reversão não implementada para ${cmd.type}.`,
      retryable: false,
    };
  }

  /**
   * Lê o alvo **no nível dele**. A versão anterior lia sempre `/ad/get/` —
   * inclusive para grupo e campanha —, e o estado anterior de todo ajuste de
   * orçamento saía vazio.
   *
   * O status é o mesmo efetivo que o sync grava (`tiktokDeliveryStatus`), e o
   * orçamento volta em unidade menor da moeda da conta, como declara
   * `ObservedEntityState`.
   */
  async observe(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<ObservedEntityState> {
    const data = await this.fetchEntity(
      cmd.target.type,
      cmd.target.externalId,
      ctx,
    );

    /**
     * Leitura com `code != 0` devolve estado **nulo**, não um estado inventado.
     * A escada de verificação lê `null` como `INCONCLUSIVE` e pergunta de novo
     * no degrau seguinte — que é o comportamento certo para "não consegui ler",
     * e o oposto de declarar divergência sobre uma resposta que não veio.
     */
    if (data?.code !== 0) return { status: null, raw: data };

    const node = data.data?.list?.[0];

    return {
      status: tiktokDeliveryStatus({
        operationStatus: node?.operation_status,
        secondaryStatus: node?.secondary_status,
      }),
      dailyBudgetMinor: DAILY_BUDGET_MODES.has(node?.budget_mode ?? '')
        ? budgetMinor(node?.budget, cmd.accountCurrency)
        : null,
      lifetimeBudgetMinor:
        node?.budget_mode === 'BUDGET_MODE_TOTAL'
          ? budgetMinor(node?.budget, cmd.accountCurrency)
          : null,
      raw: node ?? null,
    };
  }

  private capabilityFor(type: AdActionType): AdActionCapability {
    return (
      CAPABILITIES.find((capability) => capability.type === type) ?? {
        type,
        supported: false,
        reversible: false,
        requiresRecreate: false,
        createsEntity: false,
        validationDepth: 'LOCAL_ONLY',
        unsupportedReason: 'Tipo de ação desconhecido para o TikTok.',
      }
    );
  }

  /**
   * `DUPLICATE_AD` — o mesmo anúncio, no mesmo grupo, **e pausado**.
   *
   * O estado final pedido é "duplicado e pausado", não "o TikTok aceitou a
   * criação". Por isso só é `SUCCEEDED` depois de a pausa ser lida de volta.
   */
  private async duplicate(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const source = await this.readSourceAd(cmd, ctx);
    if (source.kind === 'REFUSED') return source.result;

    const created = await this.createPausedCopy(cmd, ctx, source.node, {
      overrides: {},
      nameSuffix: ' — cópia',
    });
    if (created.kind === 'FAILED') return created.result;

    if (!(await this.ensurePaused(ctx, created.adId))) {
      return {
        status: 'PARTIALLY_COMPLETED',
        exposureRisk: true,
        platformEntityId: created.adId,
        errorCode: 'COPY_PAUSE_UNCONFIRMED',
        errorMessage:
          'Anúncio duplicado, mas não foi possível confirmar que a cópia está pausada.',
        raw: created.raw,
        retryable: false,
      };
    }

    return {
      status: 'SUCCEEDED',
      platformEntityId: created.adId,
      raw: created.raw,
      retryable: false,
    };
  }

  /**
   * `REPLACE_COPY` / `REPLACE_CTA` — **recriação, e a ordem é a proteção.**
   *
   * O mesmo desenho da Meta: o anúncio novo nasce pausado (e a pausa é
   * confirmada), o antigo é pausado em seguida, e só então o novo é ligado —
   * se o antigo estava entregando. Toda falha intermediária deixa a conta
   * gastando **menos**, com uma exceção declarada: se a pausa do novo não se
   * confirma, os dois podem estar veiculando, e isso é `exposureRisk`.
   *
   * O antigo é **pausado, não excluído**: excluir é terminal, e uma troca que
   * falha no meio deixaria o usuário sem volta.
   */
  private async replaceText(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const refusal = textRefusal(cmd);
    if (refusal) return refusal;

    const source = await this.readSourceAd(cmd, ctx);
    if (source.kind === 'REFUSED') return source.result;

    const overrides =
      cmd.type === 'REPLACE_COPY'
        ? {
            ad_text: (
              cmd.parameters as ActionParametersOf<'REPLACE_COPY'>
            ).primaryText!.trim(),
          }
        : {
            call_to_action: (
              cmd.parameters as ActionParametersOf<'REPLACE_CTA'>
            ).callToAction.trim(),
          };

    const wasDelivering =
      toCanonicalStatus(
        'TIKTOK',
        tiktokDeliveryStatus({
          operationStatus: source.node.operation_status,
          secondaryStatus: source.node.secondary_status,
        }) ?? '',
      ) === 'ACTIVE';

    const created = await this.createPausedCopy(cmd, ctx, source.node, {
      overrides,
      nameSuffix: ' — texto revisado',
    });
    if (created.kind === 'FAILED') return created.result;

    const partial = (
      errorCode: string,
      errorMessage: string,
      exposureRisk: boolean,
    ): AdActionResult => ({
      status: 'PARTIALLY_COMPLETED',
      exposureRisk,
      platformEntityId: created.adId,
      errorCode,
      errorMessage,
      raw: { replacedAdId: cmd.target.externalId, created: created.raw },
      retryable: false,
    });

    if (!(await this.ensurePaused(ctx, created.adId))) {
      return partial(
        'REPLACE_NEW_PAUSE_UNCONFIRMED',
        'O anúncio novo foi criado, mas não foi possível confirmar que ele está pausado — os dois podem estar veiculando.',
        true,
      );
    }

    if (!(await this.ensurePaused(ctx, cmd.target.externalId))) {
      return partial(
        'REPLACE_OLD_NOT_PAUSED',
        'O anúncio novo foi criado pausado, mas o antigo não pôde ser pausado. A veiculação continua como estava.',
        false,
      );
    }

    if (
      wasDelivering &&
      !(await this.setAdStatus(ctx, created.adId, 'ENABLE'))
    ) {
      return partial(
        'REPLACE_NEW_NOT_ENABLED',
        'O anúncio antigo foi pausado e o novo não pôde ser ligado — a veiculação deste anúncio está parada.',
        false,
      );
    }

    return {
      status: 'SUCCEEDED',
      platformEntityId: created.adId,
      raw: { replacedAdId: cmd.target.externalId, created: created.raw },
      retryable: false,
    };
  }

  /**
   * O anúncio de origem, com as recusas que não dependem de escrever: não
   * encontrado, ou de um tipo que a recriação por cópia de campos não cobre.
   */
  private async readSourceAd(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<
    | { kind: 'OK'; node: TikTokEntityNode }
    | { kind: 'REFUSED'; result: AdActionResult }
  > {
    let data: TikTokEnvelope<TikTokEntityList> | undefined;

    try {
      data = await this.fetchEntity('AD', cmd.target.externalId, ctx);
    } catch (error) {
      return {
        kind: 'REFUSED',
        result: this.classifyTransport(error, cmd, ctx),
      };
    }

    if (data?.code !== 0) {
      return { kind: 'REFUSED', result: this.readEnvelope(data, cmd, ctx) };
    }

    const node = data.data?.list?.[0];

    if (!node?.adgroup_id) {
      return {
        kind: 'REFUSED',
        result: rejected(
          'TARGET_NOT_FOUND',
          'O anúncio não foi encontrado no TikTok.',
        ),
      };
    }

    /**
     * Anúncio de criativo automático (ACO / Smart+) não é um anúncio com um
     * texto e um vídeo: é uma combinação que a plataforma monta, com endpoints
     * próprios. Copiar campos dele produziria outro anúncio.
     */
    if (node.is_aco === true || node.is_smart_creative === true) {
      return {
        kind: 'REFUSED',
        result: rejected(
          'AD_TYPE_UNSUPPORTED',
          'Anúncios com criativo automático (ACO/Smart+) não são copiáveis por aqui.',
        ),
      };
    }

    return { kind: 'OK', node };
  }

  /**
   * Cria o anúncio novo no mesmo grupo, a partir dos campos do de origem, e pede
   * `DISABLE` na própria criação.
   *
   * Só campos da lista entram: o que `/ad/get/` devolve inclui campos de saída
   * (ids, datas, status de revisão), e reenviá-los faria a criação ser recusada.
   * Se a plataforma recusar o próprio `operation_status` na criação, a criação é
   * refeita sem ele — e a pausa passa a depender inteiramente da confirmação
   * que vem depois.
   */
  private async createPausedCopy(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    node: TikTokEntityNode,
    input: { overrides: Record<string, unknown>; nameSuffix: string },
  ): Promise<
    | { kind: 'CREATED'; adId: string; raw: unknown }
    | { kind: 'FAILED'; result: AdActionResult }
  > {
    const creative: Record<string, unknown> = { ...input.overrides };

    for (const field of COPYABLE_CREATIVE_FIELDS) {
      if (creative[field] !== undefined) continue;
      const value = node[field];
      if (value !== undefined && value !== null && value !== '') {
        creative[field] = value;
      }
    }

    creative.ad_name = `${typeof node.ad_name === 'string' ? node.ad_name : 'Anúncio'}${input.nameSuffix}`;

    let attempt = await this.postCreate(cmd, ctx, node.adgroup_id!, {
      ...creative,
      operation_status: 'DISABLE',
    });

    if (
      attempt.kind === 'ENVELOPE' &&
      attempt.data?.code !== 0 &&
      /operation_status/i.test(attempt.data?.message ?? '')
    ) {
      this.logger.warn(
        'action.tiktok_create_disable_rejected — recriando sem operation_status; a pausa será confirmada depois',
      );
      attempt = await this.postCreate(cmd, ctx, node.adgroup_id!, creative);
    }

    if (attempt.kind === 'TRANSPORT') {
      return {
        kind: 'FAILED',
        result: {
          ...this.classifyTransport(attempt.error, cmd, ctx),
          retryable: false,
          errorMessage:
            'A criação do anúncio novo não respondeu. Ele pode ter sido criado; confira a conta antes de repetir.',
        },
      };
    }

    if (attempt.data?.code !== 0) {
      return {
        kind: 'FAILED',
        result: {
          ...this.readEnvelope(attempt.data, cmd, ctx),
          retryable: false,
        },
      };
    }

    const payload = attempt.data.data;
    const adId = payload?.ad_ids?.[0] ?? payload?.creatives?.[0]?.ad_id ?? null;

    if (!adId) {
      return {
        kind: 'FAILED',
        result: {
          status: 'FAILED',
          errorCode: 'COPY_ID_MISSING',
          errorMessage:
            'O TikTok aceitou a criação mas não devolveu o id do anúncio novo. Confira a conta antes de repetir.',
          raw: attempt.data,
          retryable: false,
        },
      };
    }

    return { kind: 'CREATED', adId: String(adId), raw: attempt.data.data };
  }

  private async postCreate(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    adGroupId: string,
    creative: Record<string, unknown>,
  ): Promise<
    | {
        kind: 'ENVELOPE';
        data: TikTokEnvelope<TikTokCreateResponse> | undefined;
      }
    | { kind: 'TRANSPORT'; error: unknown }
  > {
    try {
      const { data } = await this.http.request<
        TikTokEnvelope<TikTokCreateResponse>
      >({
        url: `${TIKTOK_API}/ad/create/`,
        method: 'POST',
        integrationId: ctx.integrationId,
        headers: { 'Access-Token': ctx.accessToken },
        body: {
          advertiser_id: ctx.externalAccountId,
          adgroup_id: adGroupId,
          creatives: [creative],
        },
        // Criação nunca é repetida pelo transporte: repetir criaria outro.
        maxAttempts: 1,
      });

      return { kind: 'ENVELOPE', data };
    } catch (error) {
      this.logger.warn(
        `action.tiktok_create_transport_error type=${cmd.type} attempt=${ctx.attempt}`,
      );
      return { kind: 'TRANSPORT', error };
    }
  }

  /**
   * Pausado **confirmado por leitura**, com novas tentativas.
   *
   * Pausar é idempotente, então insistir é seguro — ao contrário de criar. A
   * resposta de sucesso da pausa não encerra a pergunta: só a leitura mostra o
   * estado que a plataforma de fato aplicou.
   */
  private async ensurePaused(
    ctx: ExecutionContext,
    adId: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= PAUSE_ATTEMPTS; attempt += 1) {
      if (await this.isPaused(ctx, adId)) return true;

      await this.setAdStatus(ctx, adId, 'DISABLE');
      if (await this.isPaused(ctx, adId)) return true;

      if (attempt < PAUSE_ATTEMPTS) {
        await this.wait(PAUSE_RETRY_DELAY_MS * attempt);
      }
    }

    this.logger.error(
      `action.tiktok_pause_unconfirmed advertiser=${ctx.externalAccountId} ad=${adId}`,
    );
    return false;
  }

  private async isPaused(
    ctx: ExecutionContext,
    adId: string,
  ): Promise<boolean> {
    try {
      const data = await this.fetchEntity('AD', adId, ctx);
      return (
        data?.code === 0 && data.data?.list?.[0]?.operation_status === 'DISABLE'
      );
    } catch {
      return false;
    }
  }

  private async setAdStatus(
    ctx: ExecutionContext,
    adId: string,
    operation: 'ENABLE' | 'DISABLE',
  ): Promise<boolean> {
    try {
      const { data } = await this.http.request<TikTokEnvelope<unknown>>({
        url: `${TIKTOK_API}/ad/status/update/`,
        method: 'POST',
        integrationId: ctx.integrationId,
        headers: { 'Access-Token': ctx.accessToken },
        body: {
          advertiser_id: ctx.externalAccountId,
          ad_ids: [adId],
          operation_status: operation,
        },
        maxAttempts: 1,
      });

      return data?.code === 0;
    } catch {
      return false;
    }
  }

  private updateStatus(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    operation: string,
  ): Promise<AdActionResult> {
    const endpoint = STATUS_ENDPOINT[cmd.target.type];

    return this.call(cmd, ctx, endpoint.path, {
      advertiser_id: ctx.externalAccountId,
      [endpoint.idsField]: [cmd.target.externalId],
      operation_status: operation,
    });
  }

  /**
   * Orçamento **diário** — conferido antes de escrever.
   *
   * O TikTok não aceita trocar o `budget_mode` na atualização, e aceita o
   * `budget` em qualquer modo. Sem a leitura, um ajuste diário confirmado pelo
   * usuário viraria o novo total de uma campanha com orçamento de voo.
   */
  private async updateDailyBudget(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    dailyBudget: number,
  ): Promise<AdActionResult> {
    const endpoint = BUDGET_ENDPOINT[cmd.target.type];

    if (!endpoint) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'PARAMETERS_UNSUPPORTED',
        errorMessage: 'Anúncio não tem orçamento próprio no TikTok.',
        retryable: false,
      };
    }

    let current: TikTokEnvelope<TikTokEntityList> | undefined;
    try {
      current = await this.fetchEntity(
        cmd.target.type,
        cmd.target.externalId,
        ctx,
      );
    } catch (error) {
      return this.classifyTransport(error, cmd, ctx);
    }

    if (current?.code !== 0) return this.readEnvelope(current, cmd, ctx);

    const node = current.data?.list?.[0];

    if (!node) {
      return rejected(
        'TARGET_NOT_FOUND',
        'O alvo não foi encontrado no TikTok.',
      );
    }

    if (!DAILY_BUDGET_MODES.has(node.budget_mode ?? '')) {
      return rejected(
        'BUDGET_NOT_DAILY',
        node.budget_mode === 'BUDGET_MODE_TOTAL'
          ? 'Este objeto usa orçamento total do período, não orçamento diário.'
          : 'Este objeto não tem orçamento diário próprio no TikTok.',
      );
    }

    /**
     * Orçamento no TikTok é número na moeda da conta — sem micros, sem
     * unidade menor. Três plataformas, três escalas: é por isso que a
     * conversão vive em cada gateway e não numa função compartilhada.
     */
    return this.call(cmd, ctx, endpoint.path, {
      advertiser_id: ctx.externalAccountId,
      [endpoint.idField]: cmd.target.externalId,
      budget: dailyBudget,
    });
  }

  private async fetchEntity(
    level: ActionLevel,
    externalId: string,
    ctx: ExecutionContext,
  ): Promise<TikTokEnvelope<TikTokEntityList> | undefined> {
    const endpoint = READ_ENDPOINT[level];
    const url = new URL(`${TIKTOK_API}${endpoint.path}`);
    url.searchParams.set('advertiser_id', ctx.externalAccountId);
    url.searchParams.set(
      'filtering',
      JSON.stringify({ [endpoint.idsField]: [externalId] }),
    );

    const { data } = await this.http.request<TikTokEnvelope<TikTokEntityList>>({
      url: url.toString(),
      method: 'GET',
      integrationId: ctx.integrationId,
      headers: { 'Access-Token': ctx.accessToken },
    });

    return data;
  }

  private async call(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    path: string,
    body: Record<string, unknown>,
  ): Promise<AdActionResult> {
    try {
      const { data } = await this.http.request<TikTokEnvelope<unknown>>({
        url: `${TIKTOK_API}${path}`,
        method: 'POST',
        integrationId: ctx.integrationId,
        headers: { 'Access-Token': ctx.accessToken },
        body,
        maxAttempts: 1,
      });

      return this.readEnvelope(data, cmd, ctx);
    } catch (error) {
      return this.classifyTransport(error, cmd, ctx);
    }
  }

  /**
   * **O `code` do corpo é a verdade, não o status HTTP.**
   *
   * Sem isto, uma recusa do TikTok — que chega com `200` — viraria uma execução
   * `SUCCEEDED`: o produto registraria como feita uma escrita que a plataforma
   * negou, e a escada de verificação leria o estado inalterado como divergência
   * causada por terceiros.
   */
  private readEnvelope(
    data: TikTokEnvelope<unknown> | undefined,
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): AdActionResult {
    if (data?.code === 0) {
      return { status: 'SUCCEEDED', raw: data.data, retryable: false };
    }

    const code = data?.code ?? -1;
    const serverSide = code >= 50000;

    this.logger.warn(
      `action.platform_error platform=TIKTOK type=${cmd.type} ` +
        `target=${cmd.target.externalId} attempt=${ctx.attempt} code=${code}`,
    );

    return {
      /**
       * `4xxxx` é recusa do pedido — parâmetro, permissão, entidade inexistente
       * —, e repetir não muda a resposta. `5xxxx` é falha do lado deles, que
       * pode passar. Um código desconhecido é tratado como recusa: insistir num
       * erro que não sabemos ler gasta cota e adia o problema.
       */
      status: serverSide ? 'FAILED' : 'REJECTED_BY_PLATFORM',
      errorCode: `tiktok_${code}`,
      errorMessage: data?.message ?? 'O TikTok recusou a escrita sem mensagem.',
      raw: data,
      retryable: serverSide,
    };
  }

  /** Falha de transporte — quando nem envelope houve. */
  private classifyTransport(
    error: unknown,
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): AdActionResult {
    if (error instanceof PlatformRequestError) {
      const classified = error.classified;
      const refusedByPlatform = PLATFORM_REFUSALS.has(classified.code);

      this.logger.warn(
        `action.transport_error platform=TIKTOK type=${cmd.type} ` +
          `attempt=${ctx.attempt} code=${classified.code}`,
      );

      return {
        status: refusedByPlatform ? 'REJECTED_BY_PLATFORM' : 'FAILED',
        errorCode: classified.code,
        errorMessage: classified.message,
        retryable: !refusedByPlatform && classified.retryable,
      };
    }

    return {
      status: 'FAILED',
      errorCode: 'UNKNOWN',
      errorMessage: error instanceof Error ? error.message : String(error),
      retryable: true,
    };
  }
}

/**
 * O texto que vai ao ar, conferido **sem rede**: a forma certa do parâmetro e o
 * limite da plataforma — o texto do TikTok tem piso e teto, e o CTA é enum.
 */
function textRefusal(cmd: AdActionCommand): AdActionResult | null {
  if (cmd.type === 'REPLACE_COPY') {
    const text = (cmd.parameters as ActionParametersOf<'REPLACE_COPY'>)
      .primaryText;

    if (!text) {
      return rejected(
        'COPY_TARGET_UNSUPPORTED',
        'No TikTok a troca de texto é do texto do anúncio (`primaryText`).',
      );
    }

    const fit = checkCopyLength('TIKTOK', 'primaryText', text);
    return fit.fits ? null : rejected('COPY_LENGTH_INVALID', fit.reason);
  }

  const cta = (cmd.parameters as ActionParametersOf<'REPLACE_CTA'>)
    .callToAction;
  const fit = checkCopyLength('TIKTOK', 'callToAction', cta);

  return fit.fits ? null : rejected('COPY_LENGTH_INVALID', fit.reason);
}

function rejected(errorCode: string, errorMessage: string): AdActionResult {
  return {
    status: 'REJECTED_BY_PLATFORM',
    errorCode,
    errorMessage,
    retryable: false,
  };
}

const PLATFORM_REFUSALS = new Set<string>([
  'bad_request',
  'permission',
  'not_found',
  'auth',
]);

type TikTokEnvelope<T> = { code: number; message?: string; data?: T };

type TikTokEntityNode = {
  operation_status?: string;
  secondary_status?: string;
  budget?: number | string;
  budget_mode?: string;
  adgroup_id?: string;
  ad_name?: string;
  is_aco?: boolean;
  is_smart_creative?: boolean;
  [field: string]: unknown;
};

type TikTokEntityList = { list?: TikTokEntityNode[] };

type TikTokCreateResponse = {
  ad_ids?: Array<string | number>;
  creatives?: Array<{ ad_id?: string | number }>;
};

/**
 * Os campos de criativo que a cópia leva. Lista fechada: o que `/ad/get/`
 * devolve inclui campos de saída, e reenviá-los faria a criação ser recusada.
 */
const COPYABLE_CREATIVE_FIELDS = [
  'ad_format',
  'ad_text',
  'call_to_action',
  'call_to_action_id',
  'video_id',
  'image_ids',
  'identity_type',
  'identity_id',
  'identity_authorized_bc_id',
  'tiktok_item_id',
  'landing_page_url',
  'display_name',
  'app_name',
  'deeplink',
  'deeplink_type',
  'tracking_pixel_id',
  'impression_tracking_url',
  'click_tracking_url',
  'page_id',
  'card_id',
  'music_id',
] as const;

/** Os modos em que `budget` é teto de um dia — o único que a ação diária pode mudar. */
const DAILY_BUDGET_MODES = new Set([
  'BUDGET_MODE_DAY',
  'BUDGET_MODE_DYNAMIC_DAILY_BUDGET',
]);

/** Sem volta por escrita: excluído, ou encerrado (`FROZEN`). */
const TERMINAL_STATUSES = new Set([
  'DELETE',
  'FROZEN',
  'AD_STATUS_DELETE',
  'ADGROUP_STATUS_DELETE',
  'CAMPAIGN_STATUS_DELETE',
  'ADGROUP_STATUS_FROZEN',
]);

/** O status do **próprio** objeto (`operation_status`); o efetivo é outro. */
function ownStatusOf(previous: ObservedEntityState): string | null {
  const raw = previous.raw as { operation_status?: string } | null | undefined;
  return raw?.operation_status ?? previous.status ?? null;
}

function budgetMinor(budget: unknown, currency: string): string | null {
  const parsed = Number(budget);
  return Number.isFinite(parsed) && parsed > 0
    ? toMinorUnits(parsed, currency)
    : null;
}

const STATUS_ENDPOINT: Record<ActionLevel, { path: string; idsField: string }> =
  {
    AD: { path: '/ad/status/update/', idsField: 'ad_ids' },
    AD_SET: { path: '/adgroup/status/update/', idsField: 'adgroup_ids' },
    CAMPAIGN: { path: '/campaign/status/update/', idsField: 'campaign_ids' },
  };

const READ_ENDPOINT: Record<ActionLevel, { path: string; idsField: string }> = {
  AD: { path: '/ad/get/', idsField: 'ad_ids' },
  AD_SET: { path: '/adgroup/get/', idsField: 'adgroup_ids' },
  CAMPAIGN: { path: '/campaign/get/', idsField: 'campaign_ids' },
};

const BUDGET_ENDPOINT: Partial<
  Record<ActionLevel, { path: string; idField: string }>
> = {
  AD_SET: { path: '/adgroup/update/', idField: 'adgroup_id' },
  CAMPAIGN: { path: '/campaign/update/', idField: 'campaign_id' },
};

/** `DELETE` é terminal, como `REMOVED` no Google. */
const OPERATION_BY_ACTION: Partial<Record<AdActionType, string>> = {
  PAUSE_AD: 'DISABLE',
  ENABLE_AD: 'ENABLE',
  ARCHIVE_AD: 'DELETE',
  PAUSE_AD_SET: 'DISABLE',
  ENABLE_AD_SET: 'ENABLE',
  PAUSE_CAMPAIGN: 'DISABLE',
  ENABLE_CAMPAIGN: 'ENABLE',
};

const stateCapability = (type: AdActionType): AdActionCapability => ({
  type,
  supported: true,
  reversible: true,
  requiresRecreate: false,
  createsEntity: false,
  validationDepth: 'LOCAL_ONLY',
});

const CAPABILITIES: AdActionCapability[] = [
  // O mesmo subconjunto de estado da Meta, nos três níveis.
  stateCapability('PAUSE_AD'),
  stateCapability('ENABLE_AD'),
  stateCapability('PAUSE_AD_SET'),
  stateCapability('ENABLE_AD_SET'),
  stateCapability('PAUSE_CAMPAIGN'),
  stateCapability('ENABLE_CAMPAIGN'),
  {
    type: 'ARCHIVE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    constraints: { terminalStatus: 'DELETE' },
  },
  {
    /** Ao contrário do Google, o TikTok tem orçamento no grupo de anúncios. */
    type: 'ADJUST_AD_SET_BUDGET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
    constraints: { rejectedWhenBudgetModeIsNotDaily: true },
  },
  {
    type: 'ADJUST_CAMPAIGN_BUDGET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
    constraints: { rejectedWhenBudgetModeIsNotDaily: true },
  },
  {
    /**
     * Irmã, não sucessora. Só é `SUCCEEDED` com a pausa lida de volta; sem ela, é
     * `PARTIALLY_COMPLETED` com risco de exposição.
     */
    type: 'DUPLICATE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: true,
    validationDepth: 'PLATFORM',
    constraints: { createdPaused: true, pauseConfirmedByRead: true },
  },
  {
    /**
     * Recria: o `ad_id` muda, há sucessor e a linhagem herda. Irreversível pelo
     * mesmo motivo da Meta — `previousState` não carrega o texto anterior.
     */
    type: 'REPLACE_COPY',
    supported: true,
    reversible: false,
    requiresRecreate: true,
    createsEntity: true,
    validationDepth: 'PLATFORM',
  },
  {
    type: 'REPLACE_CTA',
    supported: true,
    reversible: false,
    requiresRecreate: true,
    createsEntity: true,
    validationDepth: 'PLATFORM',
  },
  {
    type: 'REPLACE_CREATIVE',
    supported: false,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    unsupportedReason:
      'A Allva não troca criativo no TikTok: exigiria subir ou compor outro criativo, fora do escopo atual.',
  },
];
