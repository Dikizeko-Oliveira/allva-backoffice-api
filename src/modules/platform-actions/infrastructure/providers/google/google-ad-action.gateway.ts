import { Injectable, Logger } from '@nestjs/common';
import { isBudgetAction } from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { ActionParametersOf } from 'src/modules/ads/domain/actions/action-parameters.schema';
import { googleDeliveryStatus } from 'src/modules/ads/domain/platform/delivery-status';
import { parseGoogleUnitExternalId } from 'src/modules/ads/domain/platform/google-unit-id';
import type {
  ActionLevel,
  AdActionType,
  CopyField,
  FormatScope,
} from 'src/modules/ads/domain/platform/platform-profile';
import {
  checkCopyLength,
  copyFieldProfile,
  formatScopeRefusal,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import {
  PlatformHttpClient,
  PlatformRequestError,
} from 'src/modules/platform-clients/infrastructure/platform-http.client';
import type {
  ActionTarget,
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
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * O gateway de escrita do Google (§13.2, entrega 3 de A2-S8).
 *
 * **Quatro coisas são diferentes da Meta, e nenhuma é estilo.**
 *
 * 1. **O alvo é um resource name, e o domínio guarda o id.** O ingest grava o
 *    id numérico da campanha, do grupo e do anúncio — é o que a série de
 *    métricas usa para casar. A escrita precisa de
 *    `customers/{cid}/adGroupAds/{grupo}~{anúncio}`, então o gateway monta o
 *    resource name (campanha e grupo) ou o lê por GAQL (anúncio, cujo nome exige
 *    o grupo). Mandar o id cru como `resourceName` — o que acontecia — fazia toda
 *    escrita no Google ser recusada.
 * 2. **Dinheiro em micros**, não em unidade menor. `amountMicros` é o valor
 *    vezes 1.000.000 — a mesma escala para ¥ e para R$, ao contrário da Meta.
 * 3. **O orçamento é um recurso próprio** (`campaignBudgets`), não um campo da
 *    campanha, e pode ser **compartilhado** entre campanhas. Ajustá-lo pelo id
 *    da campanha exige ler qual orçamento ela usa — e recusar o compartilhado,
 *    que mudaria campanhas que o usuário não escolheu.
 * 4. **Remover é `remove`**, não `update` com `REMOVED`, e é terminal.
 *
 * E duas que vieram com a copy:
 *
 * - **Trocar texto é trocar um asset.** O anúncio de busca responsivo tem listas
 *   de títulos e descrições; `REPLACE_COPY` substitui **o** título ou **a**
 *   descrição que a pessoa escolheu, lendo a lista atual, alterando só aquela
 *   posição e gravando a lista com `updateMask`. O id do anúncio permanece.
 * - **Duplicar cria pausado, numa chamada.** Diferente do TikTok, o Google aceita
 *   `status: PAUSED` na criação: não existe o intervalo em que a cópia veicula.
 *
 * E uma que veio com o Performance Max (D23):
 *
 * - **A unidade pode ser um grupo de recursos.** O alvo de nível `AD` chega como
 *   `asset_group:<id>`, e pausar ou reativar vai para `assetGroups`, não para
 *   `adGroupAds`. Só essas duas ações declaram a unidade: trocar texto, duplicar
 *   ou remover um grupo são outras operações, e seguem recusadas até existirem.
 */
@Injectable()
export class GoogleAdActionGateway extends AdActionGateway {
  readonly platform: Platform = 'GOOGLE';

  private readonly logger = new Logger(GoogleAdActionGateway.name);

  constructor(
    private readonly http: PlatformHttpClient,
    private readonly envService: EnvService,
  ) {
    super();
  }

  private get adsBase(): string {
    return `https://googleads.googleapis.com/${this.envService.get('GOOGLE_ADS_API_VERSION')}`;
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
          capability.unsupportedReason ?? 'Ação não suportada no Google Ads.',
      });
    }

    if (!cmd.target.externalId) {
      failures.push({
        code: 'TARGET_NOT_RESOLVED',
        message: 'O alvo não tem id na plataforma.',
        field: 'target.externalId',
      });
    } else if (!isAddressable(cmd.target.externalId, cmd.target.type)) {
      failures.push({
        code: 'TARGET_NOT_RESOLVED',
        message: 'O id do alvo não é um id do Google Ads.',
        field: 'target.externalId',
      });
    }

    if (cmd.type === 'REPLACE_COPY') {
      const refusal = assetReplacementRefusal(cmd);
      if (refusal) {
        failures.push({
          code: refusal.errorCode ?? 'COPY_ASSET_INVALID',
          message: refusal.errorMessage ?? 'Alvo de texto inválido.',
          field: 'parameters.assetReplacement',
        });
      }
    }

    if (cmd.type === 'REPLACE_CTA') {
      const refusal = callToActionRefusal(cmd);
      if (refusal) {
        failures.push({
          code: refusal.errorCode ?? 'COPY_LENGTH_INVALID',
          message: refusal.errorMessage ?? 'Chamada para ação inválida.',
          field: 'parameters.callToAction',
        });
      }
    }

    if (isBudgetAction(cmd.type)) {
      const parameters =
        cmd.parameters as ActionParametersOf<'ADJUST_CAMPAIGN_BUDGET'>;

      // M3, igual à Meta: o valor vai na moeda da conta, e a checagem existe
      // porque o schema não conhece a conta para poder comparar.
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

    const assetGroupId = assetGroupIdOf(cmd.target);

    try {
      if (assetGroupId) {
        return await this.writeAssetGroupStatus(
          cmd,
          ctx,
          assetGroupId,
          STATUS_BY_ACTION[cmd.type],
        );
      }

      if (cmd.type === 'REPLACE_COPY') return await this.replaceAsset(cmd, ctx);
      if (cmd.type === 'REPLACE_CTA') {
        return await this.replaceCallToAction(cmd, ctx);
      }
      if (cmd.type === 'DUPLICATE_AD') return await this.duplicate(cmd, ctx);

      if (cmd.type === 'ARCHIVE_AD') {
        const resourceName = await this.resourceNameFor(cmd.target, ctx);
        if (!resourceName) return targetNotFound();

        return await this.mutate(cmd, ctx, 'adGroupAds', {
          remove: resourceName,
        });
      }

      const status = STATUS_BY_ACTION[cmd.type];

      if (status) {
        const resourceName = await this.resourceNameFor(cmd.target, ctx);
        if (!resourceName) return targetNotFound();

        return await this.mutate(cmd, ctx, SERVICE_BY_LEVEL[cmd.target.type], {
          update: { resourceName, status },
          updateMask: 'status',
        });
      }

      if (cmd.type === 'ADJUST_CAMPAIGN_BUDGET') {
        const budget = await this.dailyBudgetFor(cmd.target, ctx);
        if (budget.kind === 'REFUSED') return budget.result;

        const parameters =
          cmd.parameters as ActionParametersOf<'ADJUST_CAMPAIGN_BUDGET'>;

        return await this.mutate(cmd, ctx, 'campaignBudgets', {
          update: {
            resourceName: budget.resourceName,
            amountMicros: toMicros(parameters.dailyBudget),
          },
          updateMask: 'amount_micros',
        });
      }
    } catch (error) {
      return this.classify(error, cmd, ctx);
    }

    return {
      status: 'UNSUPPORTED',
      errorCode: 'PARAMETERS_UNSUPPORTED',
      errorMessage: `${cmd.type} não tem tradução para uma chamada do Google Ads.`,
      retryable: false,
    };
  }

  /**
   * A reversão restaura o estado capturado antes — e **`REMOVED` não volta**.
   *
   * `inverseActionOf` já recusa `ARCHIVE_AD` antes de chegar aqui. Esta é a
   * segunda linha: um caminho novo que escapasse da primeira ainda encontraria
   * esta, e o custo de errar é um anúncio que não volta.
   */
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

    if (own === 'REMOVED' || previous.status === 'REMOVED') {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'IRREVERSIBLE_STATE',
        errorMessage:
          'REMOVED é terminal no Google Ads: não há volta por escrita.',
        retryable: false,
      };
    }

    try {
      if (STATUS_BY_ACTION[cmd.type]) {
        // Só o status **do próprio recurso** é gravável. O composto
        // (`DISAPPROVED`, pausa herdada da campanha) descreve a entrega, e
        // escrevê-lo de volta seria pedir à API um valor que ela não aceita.
        if (own !== 'ENABLED' && own !== 'PAUSED') {
          return {
            status: 'UNSUPPORTED',
            errorCode: 'PREVIOUS_STATE_INCOMPLETE',
            errorMessage: `O estado anterior (${own ?? 'desconhecido'}) não é um status gravável.`,
            retryable: false,
          };
        }

        const assetGroupId = assetGroupIdOf(cmd.target);
        if (assetGroupId) {
          return await this.writeAssetGroupStatus(cmd, ctx, assetGroupId, own);
        }

        const resourceName = await this.resourceNameFor(cmd.target, ctx);
        if (!resourceName) return targetNotFound();

        return await this.mutate(cmd, ctx, SERVICE_BY_LEVEL[cmd.target.type], {
          update: { resourceName, status: own },
          updateMask: 'status',
        });
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

        const budget = await this.dailyBudgetFor(cmd.target, ctx);
        if (budget.kind === 'REFUSED') return budget.result;

        return await this.mutate(cmd, ctx, 'campaignBudgets', {
          update: {
            resourceName: budget.resourceName,
            amountMicros: toMicros(amount),
          },
          updateMask: 'amount_micros',
        });
      }
    } catch (error) {
      return this.classify(error, cmd, ctx);
    }

    return {
      status: 'UNSUPPORTED',
      errorCode: 'REVERT_UNSUPPORTED',
      errorMessage: `Reversão não implementada para ${cmd.type}.`,
      retryable: false,
    };
  }

  /**
   * O Google não tem `GET /{id}`: tudo se lê por GAQL. A escada de verificação
   * usa esta leitura como usa a da Meta — e compara com o **mesmo** status
   * efetivo que o sync grava (`googleDeliveryStatus`), para que uma escrita
   * confirmada aqui não seja lida como drift lá.
   *
   * Orçamento volta em **unidade menor** da moeda da conta, como declara
   * `ObservedEntityState`, e não em micros: é assim que a Meta responde, e
   * quem lê o campo não sabe de que plataforma ele veio.
   */
  async observe(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<ObservedEntityState> {
    const read = assetGroupIdOf(cmd.target)
      ? OBSERVE_ASSET_GROUP
      : OBSERVE[cmd.target.type];
    const query = read.query(cmd.target.externalId);

    if (!query) return { status: null, raw: null };

    const [row] = await this.search(ctx, query);
    if (!row) return { status: null, raw: null };

    return read.state(row, cmd.accountCurrency);
  }

  /**
   * Pausar ou reativar um grupo de recursos do Performance Max.
   *
   * O resource name se monta do id — o grupo, ao contrário do anúncio, não
   * exige o pai no nome. Qualquer outra ação chegando aqui é recusada: a
   * disponibilidade já barra pela unidade, e esta é a segunda linha, para que um
   * caminho novo que escape da primeira não mande uma escrita de anúncio para
   * um recurso que não é anúncio.
   */
  private async writeAssetGroupStatus(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    assetGroupId: string,
    status: string | null | undefined,
  ): Promise<AdActionResult> {
    if (!ASSET_GROUP_ACTIONS.has(cmd.type) || !status) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'ACTION_UNSUPPORTED_FOR_UNIT',
        errorMessage: `${cmd.type} não está disponível para grupo de recursos.`,
        retryable: false,
      };
    }

    if (!NUMERIC_ID.test(ctx.externalAccountId)) return targetNotFound();

    return this.mutate(cmd, ctx, 'assetGroups', {
      update: {
        resourceName: `customers/${ctx.externalAccountId}/assetGroups/${assetGroupId}`,
        status,
      },
      updateMask: 'status',
    });
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
        unsupportedReason: 'Tipo de ação desconhecido para o Google Ads.',
      }
    );
  }

  /**
   * `REPLACE_COPY` — **ler, trocar uma posição, gravar a lista**.
   *
   * A API grava `headlines` e `descriptions` como listas inteiras; não há "trocar
   * o item 2". Por isso a lista atual é lida da plataforma, e não do banco: ela
   * pode ter mudado desde o último ingest. Duas conferências antes de gravar:
   *
   * - **o asset ainda é o que a pessoa viu** (`currentValue`). Se alguém editou o
   *   anúncio no gerenciador nesse intervalo, gravar substituiria um texto que
   *   ninguém escolheu trocar;
   * - **o texto novo não repete outro asset da lista**, que a plataforma recusa.
   *
   * `pinnedField` é preservado em todos os itens: omiti-lo despinaria títulos que
   * o anunciante fixou numa posição.
   */
  private async replaceAsset(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const refusal = assetReplacementRefusal(cmd);
    if (refusal) return refusal;

    const asset = (cmd.parameters as ActionParametersOf<'REPLACE_COPY'>)
      .assetReplacement!;

    const row = await this.readAd(cmd.target, ctx);
    if (!row) return targetNotFound();

    const ad = row.adGroupAd?.ad;
    if (
      ad?.type !== 'RESPONSIVE_SEARCH_AD' ||
      !ad.responsiveSearchAd ||
      !ad.id
    ) {
      return rejected(
        'AD_TYPE_UNSUPPORTED',
        'A troca de título ou descrição vale para anúncios de busca responsivos, e este anúncio é de outro tipo.',
      );
    }

    const listKey = LIST_KEY[asset.field];
    const current = ad.responsiveSearchAd[listKey] ?? [];
    const label = ASSET_LABEL[asset.field];
    const slot = current[asset.index];

    if (!slot || (slot.text ?? '') !== asset.currentValue) {
      return rejected(
        'COPY_ASSET_CHANGED',
        `O ${label} ${asset.index + 1} não é mais "${asset.currentValue}" na plataforma. ` +
          'Atualize o anúncio e escolha de novo o que substituir.',
      );
    }

    const repeated = current.some(
      (item, index) =>
        index !== asset.index &&
        (item.text ?? '').trim().toLowerCase() ===
          asset.value.trim().toLowerCase(),
    );

    if (repeated) {
      return rejected(
        'COPY_ASSET_DUPLICATE',
        `O texto novo já existe como outro ${label} deste anúncio, e a plataforma recusa assets repetidos.`,
      );
    }

    const next = current.map((item, index) => ({
      text: index === asset.index ? asset.value.trim() : (item.text ?? ''),
      ...(item.pinnedField ? { pinnedField: item.pinnedField } : {}),
    }));

    return this.mutate(cmd, ctx, 'ads', {
      update: {
        resourceName: `customers/${ctx.externalAccountId}/ads/${ad.id}`,
        responsiveSearchAd: { [listKey]: next },
      },
      updateMask: `responsive_search_ad.${UPDATE_MASK_FIELD[asset.field]}`,
    });
  }

  /**
   * `REPLACE_CTA` — a chamada para ação **onde ela é campo do anúncio**.
   *
   * No Google ela não é do anúncio de busca: é do responsivo de display e do
   * Demand Gen de várias imagens ou carrossel, como `call_to_action_text`. Nos
   * outros formatos do Demand Gen — vídeo e produto — ela é um *asset* de CTA,
   * e trocá-la exigiria criar asset; esses ficam recusados com o motivo.
   *
   * O campo é **texto livre**, ao contrário da Meta e do TikTok, onde o CTA é um
   * valor de enum. Por isso a guarda local aqui é de tamanho, não de lista.
   *
   * A chamada igual à que já está no ar é recusada: gravar mesmo assim mandaria
   * o anúncio de volta para revisão e reiniciaria o aprendizado sem trocar uma
   * letra.
   */
  private async replaceCallToAction(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const refusal = callToActionRefusal(cmd);
    if (refusal) return refusal;

    const parameters = cmd.parameters as ActionParametersOf<'REPLACE_CTA'>;
    const text = parameters.callToAction.trim();

    const where = whereFor('ad_group_ad', cmd.target.externalId);
    if (!where) return targetNotFound();

    const rows = await this.search(
      ctx,
      `SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ${CTA_SELECT_FIELDS} FROM ad_group_ad WHERE ${where}`,
    );

    if (rows.length !== 1) return targetNotFound();

    const ad = rows[0].adGroupAd?.ad;
    const slot = ad?.type ? CTA_SLOT[ad.type] : undefined;

    if (!ad?.id || !slot) {
      return rejected(
        'AD_TYPE_UNSUPPORTED',
        `A troca de chamada para ação ${lowerFirst(
          formatScopeRefusal(CTA_SCOPE, ad?.type ?? null),
        )}`,
      );
    }

    const current = ad[slot.key]?.callToActionText ?? null;

    if (
      current !== null &&
      current.trim().toLowerCase() === text.toLowerCase()
    ) {
      return rejected(
        'CTA_UNCHANGED',
        `A chamada para ação deste anúncio já é "${current.trim()}".`,
      );
    }

    return this.mutate(cmd, ctx, 'ads', {
      update: {
        resourceName: `customers/${ctx.externalAccountId}/ads/${ad.id}`,
        [slot.key]: { callToActionText: text },
      },
      updateMask: `${slot.mask}.call_to_action_text`,
    });
  }

  /**
   * `DUPLICATE_AD` — o mesmo anúncio de busca, no mesmo grupo, **pausado**.
   *
   * Nada é enviado de fora: títulos, descrições, caminhos e URLs saem do anúncio
   * lido na plataforma. A Allva não cria nem sobe criativo; a cópia reaproveita
   * o que já existe.
   *
   * **Criação nunca volta à fila.** Uma falha de transporte pode ter acontecido
   * depois de o Google criar — repetir produziria uma segunda cópia. O desfecho
   * vai como falha definitiva, e quem decide tentar de novo é a pessoa, olhando
   * a conta.
   */
  private async duplicate(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const row = await this.readAd(cmd.target, ctx);
    if (!row) return targetNotFound();

    const ad = row.adGroupAd?.ad;
    const adGroup = row.adGroup?.resourceName;

    if (ad?.type !== 'RESPONSIVE_SEARCH_AD' || !ad.responsiveSearchAd) {
      return rejected(
        'AD_TYPE_UNSUPPORTED',
        'Duplicar vale para anúncios de busca responsivos, e este anúncio é de outro tipo.',
      );
    }

    if (!adGroup) return targetNotFound();

    const rsa = ad.responsiveSearchAd;
    const result = await this.mutate(cmd, ctx, 'adGroupAds', {
      create: {
        adGroup,
        // Pausado na própria criação: a cópia nunca veicula antes de alguém
        // decidir ligá-la.
        status: 'PAUSED',
        ad: {
          finalUrls: ad.finalUrls ?? [],
          ...(ad.finalMobileUrls?.length
            ? { finalMobileUrls: ad.finalMobileUrls }
            : {}),
          ...(ad.trackingUrlTemplate
            ? { trackingUrlTemplate: ad.trackingUrlTemplate }
            : {}),
          ...(ad.finalUrlSuffix ? { finalUrlSuffix: ad.finalUrlSuffix } : {}),
          responsiveSearchAd: {
            headlines: textAssets(rsa.headlines),
            descriptions: textAssets(rsa.descriptions),
            ...(rsa.path1 ? { path1: rsa.path1 } : {}),
            ...(rsa.path2 ? { path2: rsa.path2 } : {}),
          },
        },
      },
    });

    if (result.status !== 'SUCCEEDED') {
      return {
        ...result,
        retryable: false,
        ...(result.status === 'FAILED'
          ? {
              errorMessage:
                `${result.errorMessage ?? 'Falha ao duplicar.'} ` +
                'A cópia pode ter sido criada; confira a conta antes de repetir.',
            }
          : {}),
      };
    }

    const created = (result.raw as GoogleMutateResponse | undefined)
      ?.results?.[0]?.resourceName;
    const createdAdId = created?.split('~').pop() ?? null;

    if (!createdAdId || !NUMERIC_ID.test(createdAdId)) {
      return {
        status: 'FAILED',
        errorCode: 'COPY_ID_MISSING',
        errorMessage:
          'O Google aceitou a cópia mas não devolveu o id do anúncio novo.',
        raw: result.raw,
        retryable: false,
      };
    }

    return {
      status: 'SUCCEEDED',
      platformEntityId: createdAdId,
      raw: result.raw,
      retryable: false,
    };
  }

  /** O anúncio completo, para trocar um asset ou copiá-lo. `null` se ausente ou ambíguo. */
  private async readAd(
    target: ActionTarget,
    ctx: ExecutionContext,
  ): Promise<GoogleRow | null> {
    const where = whereFor('ad_group_ad', target.externalId);
    if (!where) return null;

    const rows = await this.search(
      ctx,
      `SELECT ad_group.resource_name, ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.ad.final_mobile_urls, ad_group_ad.ad.tracking_url_template, ad_group_ad.ad.final_url_suffix, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions, ad_group_ad.ad.responsive_search_ad.path1, ad_group_ad.ad.responsive_search_ad.path2 FROM ad_group_ad WHERE ${where}`,
    );

    return rows.length === 1 ? rows[0] : null;
  }

  /**
   * O resource name do alvo. Campanha e grupo se montam a partir do id; o
   * anúncio exige o grupo no nome, e por isso é lido.
   *
   * `null` quando o alvo não existe ou é **ambíguo** — escrever no primeiro de
   * dois resultados seria adivinhar qual o usuário quis.
   */
  private async resourceNameFor(
    target: ActionTarget,
    ctx: ExecutionContext,
  ): Promise<string | null> {
    const id = target.externalId;

    if (RESOURCE_NAME.test(id)) return id;
    if (!NUMERIC_ID.test(id) || !NUMERIC_ID.test(ctx.externalAccountId)) {
      return null;
    }

    const customer = `customers/${ctx.externalAccountId}`;
    const direct: Partial<Record<ActionLevel, string>> = {
      CAMPAIGN: `${customer}/campaigns/${id}`,
      AD_SET: `${customer}/adGroups/${id}`,
    };

    const built = direct[target.type];
    if (built) return built;

    const rows = await this.search(
      ctx,
      `SELECT ad_group_ad.resource_name FROM ad_group_ad WHERE ad_group_ad.ad.id = ${id}`,
    );

    return rows.length === 1 ? (rows[0].adGroupAd?.resourceName ?? null) : null;
  }

  /**
   * O orçamento que a campanha usa — **só se ele for diário e só dela**.
   *
   * `CUSTOM_PERIOD` é orçamento total: gravar nele um valor "diário" mudaria o
   * teto do voo inteiro. Orçamento compartilhado muda todas as campanhas que o
   * usam, e a ação foi confirmada para uma.
   */
  private async dailyBudgetFor(
    target: ActionTarget,
    ctx: ExecutionContext,
  ): Promise<
    | { kind: 'OK'; resourceName: string }
    | { kind: 'REFUSED'; result: AdActionResult }
  > {
    const lookup = budgetLookupFor(target.externalId);

    if (!lookup) {
      return refused(
        'TARGET_NOT_RESOLVED',
        'O id da campanha não é um id do Google Ads.',
      );
    }

    const [row] = await this.search(
      ctx,
      `SELECT campaign_budget.resource_name, campaign_budget.period, campaign_budget.explicitly_shared FROM ${lookup}`,
    );
    const budget = row?.campaignBudget;

    if (!budget?.resourceName) {
      return refused(
        'TARGET_NOT_FOUND',
        'A campanha não foi encontrada no Google Ads, ou não tem orçamento.',
      );
    }

    if (budget.explicitlyShared === true) {
      return refused(
        'BUDGET_SHARED',
        'O orçamento desta campanha é compartilhado com outras campanhas: alterá-lo mudaria todas elas.',
      );
    }

    if (budget.period === 'CUSTOM_PERIOD') {
      return refused(
        'BUDGET_NOT_DAILY',
        'Esta campanha usa orçamento total do período, não orçamento diário.',
      );
    }

    return { kind: 'OK', resourceName: budget.resourceName };
  }

  private async search(
    ctx: ExecutionContext,
    query: string,
  ): Promise<GoogleRow[]> {
    const { data } = await this.http.request<GoogleSearchResponse>({
      url: `${this.adsBase}/customers/${ctx.externalAccountId}/googleAds:search`,
      method: 'POST',
      integrationId: ctx.integrationId,
      headers: this.headers(ctx),
      body: { query },
    });

    return data?.results ?? [];
  }

  /**
   * Toda escrita do Google é `:mutate` com `operations`.
   *
   * **`updateMask` é obrigatório no `update`, e é a proteção.** Sem ele a API
   * trata o recurso enviado como completo e zera todo campo omitido: um ajuste
   * de orçamento sem máscara apagaria nome, método de entrega e período da
   * campanha — e a chamada retornaria sucesso.
   */
  private async mutate(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    resource: GoogleService,
    operation: Record<string, unknown>,
  ): Promise<AdActionResult> {
    try {
      const response = await this.http.request<GoogleMutateResponse>({
        url: `${this.adsBase}/customers/${ctx.externalAccountId}/${resource}:mutate`,
        method: 'POST',
        integrationId: ctx.integrationId,
        headers: this.headers(ctx),
        /**
         * `partialFailure: false` — a operação é uma só, e sucesso parcial num
         * lote de um item é uma resposta que ninguém sabe interpretar. O lote de
         * verdade é `POST /ads/actions/batch`, e lá cada item tem execução
         * própria com desfecho próprio.
         */
        body: { operations: [operation], partialFailure: false },
        // Uma tentativa: quem decide repetir é o worker, que conhece o estado da
        // execução e carrega a chave de idempotência.
        maxAttempts: 1,
      });

      return { status: 'SUCCEEDED', raw: response.data, retryable: false };
    } catch (error) {
      return this.classify(error, cmd, ctx);
    }
  }

  private headers(ctx: ExecutionContext): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${ctx.accessToken}`,
      'developer-token':
        this.envService.get('GOOGLE_ADS_DEVELOPER_TOKEN') ?? '',
    };

    const loginCustomerId = this.envService.get('GOOGLE_ADS_LOGIN_CUSTOMER_ID');
    if (loginCustomerId) headers['login-customer-id'] = loginCustomerId;

    return headers;
  }

  private classify(
    error: unknown,
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): AdActionResult {
    if (error instanceof PlatformRequestError) {
      const classified = error.classified;
      const refusedByPlatform = PLATFORM_REFUSALS.has(classified.code);

      this.logger.warn(
        `action.platform_error platform=GOOGLE type=${cmd.type} ` +
          `target=${cmd.target.externalId} attempt=${ctx.attempt} code=${classified.code}`,
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
 * O alvo de texto do Google, conferido **sem rede**: presença, tamanho e limite
 * da plataforma. O que depende da conta — o asset ainda ser o que a pessoa viu —
 * é conferido na execução, contra a leitura fresca.
 */
function assetReplacementRefusal(cmd: AdActionCommand): AdActionResult | null {
  const parameters = cmd.parameters as ActionParametersOf<'REPLACE_COPY'>;
  const asset = parameters.assetReplacement;

  if (!asset) {
    return rejected(
      'COPY_ASSET_TARGET_REQUIRED',
      'No Google a troca de texto é de um título ou de uma descrição específicos: escolha qual substituir.',
    );
  }

  const fit = checkCopyLength('GOOGLE', COPY_FIELD[asset.field], asset.value);

  return fit.fits ? null : rejected('COPY_LENGTH_INVALID', fit.reason);
}

/**
 * O CTA conferido **sem rede**: tamanho e limite da plataforma. Se o anúncio
 * tem o campo é a execução que responde, contra a leitura fresca.
 */
function callToActionRefusal(cmd: AdActionCommand): AdActionResult | null {
  const parameters = cmd.parameters as ActionParametersOf<'REPLACE_CTA'>;
  const fit = checkCopyLength(
    'GOOGLE',
    'callToAction',
    parameters.callToAction,
  );

  return fit.fits ? null : rejected('COPY_LENGTH_INVALID', fit.reason);
}

/** "Vale para…" no meio de uma frase — a recusa é uma só, dita em dois lugares. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/**
 * Micros: o valor vezes 1.000.000, **independente da moeda**. O Google usa a
 * mesma escala para ¥ e para R$ — o oposto da Meta, onde o expoente ISO 4217
 * decide. É por isso que a escrita não usa `toMinorUnits`.
 */
function toMicros(amount: number): string {
  return String(Math.round(amount * 1_000_000));
}

/** Micros → unidade menor da moeda da conta — o formato de `ObservedEntityState`. */
function microsToMinor(micros: unknown, currency: string): string | null {
  const parsed = Number(micros);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return toMinorUnits(parsed / 1_000_000, currency);
}

/** Os assets como a criação espera: texto e posição fixada, nada de campo de saída. */
function textAssets(
  assets: GoogleTextAsset[] | undefined,
): Array<{ text: string; pinnedField?: string }> {
  return (assets ?? []).map((asset) => ({
    text: asset.text ?? '',
    ...(asset.pinnedField ? { pinnedField: asset.pinnedField } : {}),
  }));
}

const NUMERIC_ID = /^\d+$/;
const RESOURCE_NAME = /^customers\/\d+\/[A-Za-z]+\/\d+(?:~\d+)?$/;
const BUDGET_RESOURCE_NAME = /^customers\/\d+\/campaignBudgets\/\d+$/;

/**
 * O que entra numa consulta GAQL vindo de fora: id numérico ou resource name
 * bem formado, e nada mais. O valor é interpolado — sem esta checagem, um id
 * adulterado viraria cláusula.
 */
function isAddressable(externalId: string, level: ActionLevel): boolean {
  if (NUMERIC_ID.test(externalId) || RESOURCE_NAME.test(externalId)) {
    return true;
  }
  // O grupo de recursos só é alvo de ação de nível `AD` — é a unidade.
  return level === 'AD' && assetGroupIdOf({ type: level, externalId }) !== null;
}

/**
 * O id do grupo de recursos, quando o alvo é um. Só no nível `AD`: campanha e
 * conjunto nunca carregam o prefixo, e um id prefixado ali é id adulterado.
 */
function assetGroupIdOf(
  target: Pick<ActionTarget, 'type' | 'externalId'>,
): string | null {
  if (target.type !== 'AD') return null;
  const ref = parseGoogleUnitExternalId(target.externalId);
  return ref?.kind === 'ASSET_GROUP' ? ref.assetGroupId : null;
}

function whereFor(
  resource: 'campaign' | 'ad_group' | 'ad_group_ad',
  externalId: string,
): string | null {
  if (RESOURCE_NAME.test(externalId)) {
    return `${resource}.resource_name = '${externalId}'`;
  }
  if (!NUMERIC_ID.test(externalId)) return null;

  return resource === 'ad_group_ad'
    ? `ad_group_ad.ad.id = ${externalId}`
    : `${resource}.id = ${externalId}`;
}

/** `FROM ... WHERE ...` que acha o orçamento pela campanha ou pelo próprio recurso. */
function budgetLookupFor(externalId: string): string | null {
  if (BUDGET_RESOURCE_NAME.test(externalId)) {
    return `campaign_budget WHERE campaign_budget.resource_name = '${externalId}'`;
  }

  const where = whereFor('campaign', externalId);
  return where ? `campaign WHERE ${where}` : null;
}

function rejected(errorCode: string, errorMessage: string): AdActionResult {
  return {
    status: 'REJECTED_BY_PLATFORM',
    errorCode,
    errorMessage,
    retryable: false,
  };
}

function refused(
  errorCode: string,
  errorMessage: string,
): { kind: 'REFUSED'; result: AdActionResult } {
  return { kind: 'REFUSED', result: rejected(errorCode, errorMessage) };
}

function targetNotFound(): AdActionResult {
  return rejected(
    'TARGET_NOT_FOUND',
    'O alvo não foi encontrado no Google Ads, ou o id não identifica um recurso só.',
  );
}

/** O status do **próprio** recurso, guardado em `raw` pela leitura; o composto é outro. */
function ownStatusOf(previous: ObservedEntityState): string | null {
  const raw = previous.raw as { ownStatus?: string | null } | null | undefined;
  return raw?.ownStatus ?? previous.status ?? null;
}

type AssetField = 'HEADLINE' | 'DESCRIPTION';

const LIST_KEY: Record<AssetField, 'headlines' | 'descriptions'> = {
  HEADLINE: 'headlines',
  DESCRIPTION: 'descriptions',
};

const UPDATE_MASK_FIELD: Record<AssetField, string> = {
  HEADLINE: 'headlines',
  DESCRIPTION: 'descriptions',
};

const COPY_FIELD: Record<AssetField, CopyField> = {
  HEADLINE: 'headline',
  DESCRIPTION: 'description',
};

const ASSET_LABEL: Record<AssetField, string> = {
  HEADLINE: 'título',
  DESCRIPTION: 'descrição',
};

/**
 * Onde cada formato guarda a chamada para ação — e o recorte de formatos, que
 * vem do **perfil**, não de uma segunda lista aqui: a tela, a recomendação e
 * esta escrita precisam concordar sobre onde o CTA existe.
 */
const CTA_SLOT: Partial<Record<string, { key: GoogleCtaKey; mask: string }>> = {
  RESPONSIVE_DISPLAY_AD: {
    key: 'responsiveDisplayAd',
    mask: 'responsive_display_ad',
  },
  DEMAND_GEN_MULTI_ASSET_AD: {
    key: 'demandGenMultiAssetAd',
    mask: 'demand_gen_multi_asset_ad',
  },
  DEMAND_GEN_CAROUSEL_AD: {
    key: 'demandGenCarouselAd',
    mask: 'demand_gen_carousel_ad',
  },
};

const CTA_SCOPE: FormatScope = copyFieldProfile('GOOGLE', 'callToAction')
  .writableFormats ?? { formats: [], label: 'nenhum formato' };

const CTA_SELECT_FIELDS = [
  'ad_group_ad.ad.responsive_display_ad.call_to_action_text',
  'ad_group_ad.ad.demand_gen_multi_asset_ad.call_to_action_text',
  'ad_group_ad.ad.demand_gen_carousel_ad.call_to_action_text',
].join(', ');

type GoogleService =
  | 'adGroupAds'
  | 'adGroups'
  | 'assetGroups'
  | 'campaigns'
  | 'campaignBudgets'
  | 'ads';

const SERVICE_BY_LEVEL: Record<ActionLevel, GoogleService> = {
  AD: 'adGroupAds',
  AD_SET: 'adGroups',
  CAMPAIGN: 'campaigns',
};

type GoogleTextAsset = { text?: string; pinnedField?: string };

type GoogleCtaKey =
  | 'responsiveDisplayAd'
  | 'demandGenMultiAssetAd'
  | 'demandGenCarouselAd';

type GoogleCtaNode = { callToActionText?: string };

type GoogleRow = {
  adGroupAd?: {
    resourceName?: string;
    status?: string;
    policySummary?: { approvalStatus?: string; reviewStatus?: string };
    ad?: {
      id?: string;
      type?: string;
      finalUrls?: string[];
      finalMobileUrls?: string[];
      trackingUrlTemplate?: string;
      finalUrlSuffix?: string;
      responsiveSearchAd?: {
        headlines?: GoogleTextAsset[];
        descriptions?: GoogleTextAsset[];
        path1?: string;
        path2?: string;
      };
      responsiveDisplayAd?: GoogleCtaNode;
      demandGenMultiAssetAd?: GoogleCtaNode;
      demandGenCarouselAd?: GoogleCtaNode;
    };
  };
  adGroup?: { resourceName?: string; status?: string };
  assetGroup?: { status?: string };
  campaign?: { status?: string };
  campaignBudget?: {
    resourceName?: string;
    amountMicros?: string;
    totalAmountMicros?: string;
    period?: string;
    explicitlyShared?: boolean;
  };
};

type GoogleMutateResponse = { results?: Array<{ resourceName?: string }> };

type GoogleSearchResponse = { results?: GoogleRow[] };

/** A leitura de cada nível: a consulta e o estado que ela vira. */
const OBSERVE: Record<
  ActionLevel,
  {
    query: (externalId: string) => string | null;
    state: (row: GoogleRow, currency: string) => ObservedEntityState;
  }
> = {
  AD: {
    query: (externalId) => {
      const where = whereFor('ad_group_ad', externalId);
      return where
        ? `SELECT ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.policy_summary.review_status, ad_group.status, campaign.status FROM ad_group_ad WHERE ${where}`
        : null;
    },
    state: (row) => ({
      status: googleDeliveryStatus({
        adStatus: row.adGroupAd?.status,
        adGroupStatus: row.adGroup?.status,
        campaignStatus: row.campaign?.status,
        approvalStatus: row.adGroupAd?.policySummary?.approvalStatus,
        reviewStatus: row.adGroupAd?.policySummary?.reviewStatus,
      }),
      raw: { ownStatus: row.adGroupAd?.status ?? null, row },
    }),
  },
  AD_SET: {
    query: (externalId) => {
      const where = whereFor('ad_group', externalId);
      return where
        ? `SELECT ad_group.status, campaign.status FROM ad_group WHERE ${where}`
        : null;
    },
    state: (row) => ({
      status: googleDeliveryStatus({
        adStatus: row.adGroup?.status,
        campaignStatus: row.campaign?.status,
      }),
      raw: { ownStatus: row.adGroup?.status ?? null, row },
    }),
  },
  CAMPAIGN: {
    query: (externalId) => {
      if (BUDGET_RESOURCE_NAME.test(externalId)) {
        return `SELECT campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period FROM campaign_budget WHERE campaign_budget.resource_name = '${externalId}'`;
      }
      const where = whereFor('campaign', externalId);
      return where
        ? `SELECT campaign.status, campaign_budget.amount_micros, campaign_budget.total_amount_micros, campaign_budget.period FROM campaign WHERE ${where}`
        : null;
    },
    state: (row, currency) => {
      const customPeriod = row.campaignBudget?.period === 'CUSTOM_PERIOD';

      return {
        status: row.campaign?.status ?? null,
        dailyBudgetMinor: customPeriod
          ? null
          : microsToMinor(row.campaignBudget?.amountMicros, currency),
        lifetimeBudgetMinor: customPeriod
          ? microsToMinor(row.campaignBudget?.totalAmountMicros, currency)
          : null,
        raw: { ownStatus: row.campaign?.status ?? null, row },
      };
    },
  },
};

/** A leitura do grupo de recursos — a unidade do Performance Max (D23). */
const OBSERVE_ASSET_GROUP: (typeof OBSERVE)[ActionLevel] = {
  query: (externalId) => {
    const ref = parseGoogleUnitExternalId(externalId);
    return ref?.kind === 'ASSET_GROUP'
      ? `SELECT asset_group.status, campaign.status FROM asset_group WHERE asset_group.id = ${ref.assetGroupId}`
      : null;
  },
  // A mesma composição que o sync grava para o grupo: sem ela, a pausa
  // confirmada aqui seria lida como drift na leitura seguinte.
  state: (row) => ({
    status: googleDeliveryStatus({
      adStatus: row.assetGroup?.status,
      campaignStatus: row.campaign?.status,
    }),
    raw: { ownStatus: row.assetGroup?.status ?? null, row },
  }),
};

/** As únicas ações de nível `AD` que sabem escrever num grupo de recursos. */
const ASSET_GROUP_ACTIONS = new Set<AdActionType>(['PAUSE_AD', 'ENABLE_AD']);

/**
 * As ações de campanha que valem igual para a campanha de um grupo de recursos:
 * a campanha PMax é uma campanha como as outras, com o mesmo `status` e o mesmo
 * orçamento em `campaignBudgets`.
 */
const ASSET_GROUP_CAMPAIGN_ACTIONS = new Set<AdActionType>([
  'PAUSE_CAMPAIGN',
  'ENABLE_CAMPAIGN',
  'ADJUST_CAMPAIGN_BUDGET',
]);

const WITH_ASSET_GROUP = { units: ['AD', 'ASSET_GROUP'] as const };

const PLATFORM_REFUSALS = new Set<string>([
  'bad_request',
  'permission',
  'not_found',
  'auth',
]);

/** Status que cada ação pede. `ARCHIVE_AD` não está aqui: é `remove`. */
const STATUS_BY_ACTION: Partial<Record<AdActionType, string>> = {
  PAUSE_AD: 'PAUSED',
  ENABLE_AD: 'ENABLED',
  PAUSE_AD_SET: 'PAUSED',
  ENABLE_AD_SET: 'ENABLED',
  PAUSE_CAMPAIGN: 'PAUSED',
  ENABLE_CAMPAIGN: 'ENABLED',
};

function stateCapability(type: AdActionType): AdActionCapability {
  return {
    type,
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    // Pausar e reativar valem também para o grupo de recursos (D23): é o mesmo
    // campo `status`, em outro serviço — e a campanha dele é campanha comum.
    ...(ASSET_GROUP_ACTIONS.has(type) || ASSET_GROUP_CAMPAIGN_ACTIONS.has(type)
      ? WITH_ASSET_GROUP
      : {}),
  };
}

function unsupported(
  type: AdActionType,
  unsupportedReason: string,
): AdActionCapability {
  return {
    type,
    supported: false,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    unsupportedReason,
  };
}

const CAPABILITIES: AdActionCapability[] = [
  // O mesmo subconjunto de estado da Meta, nos três níveis.
  stateCapability('PAUSE_AD'),
  stateCapability('ENABLE_AD'),
  stateCapability('PAUSE_AD_SET'),
  stateCapability('ENABLE_AD_SET'),
  stateCapability('PAUSE_CAMPAIGN'),
  stateCapability('ENABLE_CAMPAIGN'),
  {
    /** `remove` no Google — e o `PlatformProfile` o declara irreversível. */
    type: 'ARCHIVE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    constraints: { terminalStatus: 'REMOVED' },
  },
  {
    type: 'ADJUST_CAMPAIGN_BUDGET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
    ...WITH_ASSET_GROUP,
    constraints: {
      rejectedForSharedBudgets: true,
      rejectedForCustomPeriodBudgets: true,
    },
  },
  {
    /**
     * Edição em lugar de **um** asset: o id do anúncio permanece, então não há
     * recriação nem entidade nova. O aprendizado reinicia e o anúncio volta à
     * revisão — isso é impacto, e vem do `PlatformProfile`.
     *
     * `reversible: false` pelo mesmo motivo da Meta: a reversão por
     * `previousState` não carrega texto.
     */
    type: 'REPLACE_COPY',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
    formats: copyFieldProfile('GOOGLE', 'headline').writableFormats,
    constraints: {
      target: 'ASSET',
      assetFields: ['HEADLINE', 'DESCRIPTION'],
    },
  },
  {
    /**
     * Texto do anúncio, editado em lugar: o id permanece e nada é recriado. O
     * recorte de formatos é o do perfil — no anúncio de busca a ação nem chega
     * a ser oferecida.
     */
    type: 'REPLACE_CTA',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
    formats: CTA_SCOPE,
  },
  {
    /** Irmã, não sucessora: nasce pausada e o original segue veiculando. */
    type: 'DUPLICATE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: true,
    validationDepth: 'PLATFORM',
    formats: copyFieldProfile('GOOGLE', 'headline').writableFormats,
    constraints: { createdPaused: true },
  },
  {
    /**
     * Não é "ainda não implementado": **não existe**. Orçamento no Google vive
     * na campanha, e um grupo de anúncios não tem o próprio. Declarar com o
     * motivo certo é o que impede a tela de oferecer um botão que só pode
     * falhar — e de o usuário abrir chamado sobre uma limitação nossa que na
     * verdade é da plataforma.
     */
    type: 'ADJUST_AD_SET_BUDGET',
    supported: false,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
    unsupportedReason:
      'No Google Ads o orçamento vive na campanha: grupos de anúncios não têm orçamento próprio.',
  },
  unsupported(
    'REPLACE_CREATIVE',
    'A Allva não troca criativo no Google: exigiria compor o anúncio com outros ativos, fora do escopo atual.',
  ),
];
