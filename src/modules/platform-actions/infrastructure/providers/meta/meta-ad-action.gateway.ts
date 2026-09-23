import { Injectable, Logger } from '@nestjs/common';
import {
  ActionParametersOf,
  isBudgetAction,
} from 'src/modules/ads/domain/actions/action-parameters.schema';
import type { AdActionType } from 'src/modules/ads/domain/platform/platform-profile';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { PlatformHttpClient } from 'src/modules/platform-clients/infrastructure/platform-http.client';
import { PlatformRequestError } from 'src/modules/platform-clients/infrastructure/platform-http.client';
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
import { toMinorUnits } from 'src/shared/domain/money';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * O gateway de escrita da Meta (§13.2).
 *
 * **Subconjunto declarado, não parcial por acidente.** Pausar e reativar nos três
 * níveis, ajustar orçamento em conjunto e campanha, e arquivar: são as ações que
 * a Meta faz por mudança de estado ou de valor, e que este gateway executa hoje.
 * As quatro que **recriam** a entidade — `DUPLICATE_AD`, `REPLACE_CREATIVE`,
 * `REPLACE_COPY`, `REPLACE_CTA` — aparecem em `capabilities()` com
 * `supported: false` e motivo. A diferença importa: uma ação ausente da lista é
 * um bug do ponto de vista de quem consome, e uma ação declarada indisponível é
 * uma resposta.
 *
 * As chamadas passam por `PlatformHttpClient`, que já classifica erro por status
 * e respeita `Retry-After` (§13.4). Reimplementar retry aqui produziria uma
 * segunda política divergindo em silêncio da que o sync usa há dois sprints.
 */
@Injectable()
export class MetaAdActionGateway extends AdActionGateway {
  readonly platform: Platform = 'META';

  private readonly logger = new Logger(MetaAdActionGateway.name);

  constructor(
    private readonly http: PlatformHttpClient,
    private readonly envService: EnvService,
  ) {
    super();
  }

  private get apiVersion(): string {
    return this.envService.get('META_API_VERSION');
  }

  capabilities(): AdActionCapability[] {
    return CAPABILITIES;
  }

  /**
   * Validação **local**. A profundidade é declarada na resposta justamente
   * porque ela não sabe o que só a plataforma sabe: se o ad set está sob CBO,
   * se o anúncio está em revisão, se o criativo foi removido.
   */
  validate(cmd: AdActionCommand): Promise<ValidationResult> {
    const failures: ValidationFailure[] = [];
    const capability = this.capabilityFor(cmd.type);

    if (!capability.supported) {
      failures.push({
        code: 'ACTION_UNSUPPORTED',
        message: capability.unsupportedReason ?? 'Ação não suportada na Meta.',
      });
    }

    if (!cmd.target.externalId) {
      failures.push({
        code: 'TARGET_NOT_RESOLVED',
        message: 'O alvo não tem id na plataforma.',
        field: 'target.externalId',
      });
    }

    if (isBudgetAction(cmd.type)) {
      const parameters =
        cmd.parameters as ActionParametersOf<'ADJUST_AD_SET_BUDGET'>;

      /**
       * **M3 verificado aqui, não confiado.** O schema já exige `currency`; o
       * que esta checagem impede é o caso em que ele veio preenchido com a
       * moeda-base da organização enquanto a conta opera em outra. O schema não
       * tem como saber disso — ele não conhece a conta —, e o resultado não
       * seria um erro visível: seria um orçamento plausível na moeda errada.
       */
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

    /**
     * Duplicar não é mudar um campo: é um endpoint próprio (`/copies`) que
     * **cria** entidade. Tratá-lo dentro de `bodyFor` obrigaria aquele método a
     * devolver também a URL, e ele existe justamente para responder "que campos
     * mudam neste alvo".
     */
    if (cmd.type === 'DUPLICATE_AD') return this.duplicate(cmd, ctx);

    /**
     * Texto vive no criativo, e criativo da Meta é **imutável**: não há como
     * editar `object_story_spec`. Trocar a copy é compor um criativo novo e
     * substituir o anúncio — quatro chamadas encadeadas, com uma ordem que a
     * função explica.
     */
    if (cmd.type === 'REPLACE_COPY' || cmd.type === 'REPLACE_CTA') {
      /**
       * Na Meta a troca é do **texto principal**. O alvo de asset
       * (`assetReplacement`) é o vocabulário do Google: aceitá-lo aqui comporia
       * um criativo com `message` vazio.
       */
      if (
        cmd.type === 'REPLACE_COPY' &&
        !(cmd.parameters as ActionParametersOf<'REPLACE_COPY'>).primaryText
      ) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'COPY_TARGET_UNSUPPORTED',
          errorMessage:
            'Na Meta a troca de texto é do texto principal (`primaryText`).',
          retryable: false,
        };
      }

      return this.replaceText(cmd, ctx);
    }

    const body = this.bodyFor(cmd);

    if (!body) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'PARAMETERS_UNSUPPORTED',
        errorMessage: `${cmd.type} não tem tradução para uma chamada da Meta.`,
        retryable: false,
      };
    }

    return this.post(cmd, ctx, body);
  }

  /**
   * A reversão é uma escrita nova derivada de `previousState` — nunca a
   * inversão sintática do comando original.
   *
   * `previousState` sem o campo que a ação mudou não é revertível: aplicar um
   * default aqui restauraria um estado que **nunca existiu**, e o usuário
   * receberia "revertido" sobre uma mudança que na verdade foi uma terceira
   * escrita arbitrária.
   */
  async revert(
    cmd: AdActionCommand,
    previousState: unknown,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const previous = previousState as ObservedEntityState | null;

    if (!previous) {
      return {
        status: 'UNSUPPORTED',
        errorCode: 'PREVIOUS_STATE_MISSING',
        errorMessage: 'Não há estado anterior capturado para reverter.',
        retryable: false,
      };
    }

    if (STATUS_BY_ACTION[cmd.type]) {
      if (!previous.status) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'PREVIOUS_STATE_INCOMPLETE',
          errorMessage: 'O estado anterior não registrou o status do alvo.',
          retryable: false,
        };
      }

      return this.post(cmd, ctx, { status: previous.status });
    }

    if (cmd.type === 'REPLACE_CREATIVE') {
      /**
       * Reverter uma troca de criativo exige o criativo anterior, e
       * `previousState` guarda status e orçamento — não o vínculo. Recusar aqui
       * é melhor que restaurar um criativo adivinhado: o usuário escolhe qual
       * quer de volta, com a lista à frente.
       */
      return {
        status: 'UNSUPPORTED',
        errorCode: 'PREVIOUS_STATE_INCOMPLETE',
        errorMessage:
          'O estado anterior não registrou qual criativo estava vinculado.',
        retryable: false,
      };
    }

    if (isBudgetAction(cmd.type)) {
      if (!previous.dailyBudgetMinor) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'PREVIOUS_STATE_INCOMPLETE',
          errorMessage: 'O estado anterior não registrou daily_budget.',
          retryable: false,
        };
      }

      return this.post(cmd, ctx, {
        daily_budget: previous.dailyBudgetMinor,
      });
    }

    return {
      status: 'UNSUPPORTED',
      errorCode: 'REVERT_UNSUPPORTED',
      errorMessage: `Reversão não implementada para ${cmd.type}.`,
      retryable: false,
    };
  }

  async observe(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<ObservedEntityState> {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${cmd.target.externalId}`,
    );
    url.searchParams.set('fields', OBSERVE_FIELDS[cmd.target.type]);
    url.searchParams.set('access_token', ctx.accessToken);

    const response = await this.http.request<MetaEntityNode>({
      url: url.toString(),
      method: 'GET',
      integrationId: ctx.integrationId,
    });

    const node = response.data;

    return {
      /**
       * `effective_status` antes de `status`: o primeiro é o que a plataforma
       * de fato veicula, e um anúncio ativo dentro de um conjunto pausado
       * responde `status: ACTIVE` — que confirmaria uma escrita que não teve
       * efeito nenhum sobre a entrega.
       */
      status: node.effective_status ?? node.status ?? null,
      dailyBudgetMinor: node.daily_budget ?? null,
      lifetimeBudgetMinor: node.lifetime_budget ?? null,
      raw: node,
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
        unsupportedReason: 'Tipo de ação desconhecido para a Meta.',
      }
    );
  }

  /**
   * O corpo do `POST` da Meta para este comando, ou `null` se não houver.
   *
   * Decide pelo **tipo da ação**, que é o que o banco grava e o que a
   * capability declara. Decidir pela forma dos parâmetros criaria uma segunda
   * taxonomia paralela a `AdActionType`, e duas taxonomias da mesma coisa é
   * como `PAUSE_AD_SET` e `PAUSE_AD` acabariam indistinguíveis no caminho de
   * escrita — pausando a entidade errada.
   */
  private bodyFor(cmd: AdActionCommand): Record<string, string> | null {
    const status = STATUS_BY_ACTION[cmd.type];
    if (status) return { status };

    if (cmd.type === 'REPLACE_CREATIVE') {
      const parameters =
        cmd.parameters as ActionParametersOf<'REPLACE_CREATIVE'>;

      /**
       * **Edição em lugar** (§13.1): o `ad_id` permanece e só o vínculo com o
       * criativo muda. O que muda de fato para o usuário — aprendizado
       * reiniciado, prova social perdida — é impacto, não estratégia, e viaja
       * por `actionImpactFor`, não por aqui.
       */
      return {
        creative: JSON.stringify({ creative_id: parameters.creativeId }),
      };
    }

    if (isBudgetAction(cmd.type)) {
      const parameters =
        cmd.parameters as ActionParametersOf<'ADJUST_AD_SET_BUDGET'>;

      /**
       * M3 e unidade menor no mesmo lugar: o valor vai na moeda da **conta**, e
       * a conversão respeita o expoente da moeda. `¥50.000 * 100` seria cem
       * vezes o orçamento que o usuário confirmou.
       */
      return {
        daily_budget: toMinorUnits(parameters.dailyBudget, parameters.currency),
      };
    }

    return null;
  }

  /**
   * `POST /{ad_id}/copies` — a cópia nasce **pausada**, sempre.
   *
   * `status_option: PAUSED` não é preferência: uma duplicata que começa a
   * veicular no instante em que é criada dobra o gasto do anúncio sem que
   * ninguém tenha confirmado o orçamento dela. O usuário liga depois, olhando —
   * que é a ordem que R1 pede.
   *
   * A cópia é **irmã**, não sucessora: o original continua veiculando. Por isso
   * ela começa a própria linhagem, e `producesSuccessor` a exclui da herança.
   */
  private async duplicate(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${cmd.target.externalId}/copies`;

    try {
      const response = await this.http.request<MetaCopyResponse>({
        url,
        method: 'POST',
        integrationId: ctx.integrationId,
        body: {
          status_option: 'PAUSED',
          rename_options: JSON.stringify({ rename_suffix: ' — cópia' }),
          access_token: ctx.accessToken,
        },
        maxAttempts: 1,
      });

      const created =
        response.data?.copied_ad_id ?? response.data?.ad_object_id ?? null;

      /**
       * Sem id de volta não há como ligar a cópia a esta execução, e o ingest
       * seguinte a descobriria como anúncio anônimo. `FAILED` e não
       * `SUCCEEDED`: a Meta pode ter criado — e é justamente por não sabermos
       * que a verificação precisa acontecer, não a confirmação.
       */
      if (!created) {
        return {
          status: 'FAILED',
          errorCode: 'COPY_ID_MISSING',
          errorMessage:
            'A Meta aceitou a cópia mas não devolveu o id do anúncio novo.',
          raw: response.data,
          retryable: false,
        };
      }

      return {
        status: 'SUCCEEDED',
        platformEntityId: created,
        raw: response.data,
        retryable: false,
      };
    } catch (error) {
      return this.classify(error, cmd, ctx);
    }
  }

  /**
   * `REPLACE_COPY` / `REPLACE_CTA` — **a ordem é a proteção.**
   *
   * A sequência óbvia seria criar o novo e depois desligar o antigo. Ela tem um
   * modo de falha caro: se a última chamada falhar, dois anúncios ficam
   * veiculando a mesma coisa e o gasto **dobra** — exatamente R1. A ordem aqui
   * é a inversa no ponto que importa: o anúncio novo nasce **pausado**, o
   * antigo é pausado em seguida, e só então o novo é ligado. Toda falha
   * intermediária deixa o sistema gastando **menos**, nunca mais.
   *
   * O antigo é **pausado, não arquivado**. Arquivar é irreversível na Meta
   * (§13.1), e uma substituição que falha no meio deixaria o usuário sem volta.
   * Quem arquiva o antigo é o usuário, depois, olhando o novo funcionar.
   */
  private async replaceText(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): Promise<AdActionResult> {
    let createdAdId: string | null = null;

    try {
      const current = await this.readAdForRecreate(cmd, ctx);
      const { adsetId, storySpec } = current;

      if (!adsetId || !storySpec) {
        return {
          status: 'UNSUPPORTED',
          errorCode: 'CREATIVE_NOT_COMPOSABLE',
          errorMessage:
            'Este anúncio não expõe o criativo num formato que permita trocar o texto.',
          retryable: false,
        };
      }

      const creativeId = await this.composeCreative(cmd, ctx, {
        name: current.name,
        storySpec,
      });

      createdAdId = await this.createAd(ctx, {
        adsetId,
        name: current.name,
        creativeId,
      });

      // A partir daqui existe entidade criada: toda saída carrega o id, mesmo
      // em falha. Sem ele, o anúncio novo ficaria órfão — pausado, invisível
      // para a linhagem, e descoberto pelo ingest como anúncio sem origem.
      /**
       * `postToEntity` e **não** `post`: o segundo classifica o erro e devolve
       * um resultado, sem lançar. Usá-lo aqui faria uma falha ao pausar o
       * antigo passar despercebida, e o passo seguinte ligaria o novo — dois
       * anúncios veiculando a mesma coisa, que é o gasto dobrado de R1 que esta
       * ordem existe para impedir.
       */
      await this.postToEntity(cmd.target.externalId, ctx, { status: 'PAUSED' });

      if (current.wasDelivering) {
        await this.postToEntity(createdAdId, ctx, { status: 'ACTIVE' });
      }

      return {
        status: 'SUCCEEDED',
        platformEntityId: createdAdId,
        raw: { replacedAdId: cmd.target.externalId, creativeId },
        retryable: false,
      };
    } catch (error) {
      const failure = this.classify(error, cmd, ctx);

      return createdAdId
        ? { ...failure, platformEntityId: createdAdId }
        : failure;
    }
  }

  /** O que a composição precisa saber do anúncio atual, numa leitura só. */
  private async readAdForRecreate(cmd: AdActionCommand, ctx: ExecutionContext) {
    const url = new URL(
      `https://graph.facebook.com/${this.apiVersion}/${cmd.target.externalId}`,
    );
    url.searchParams.set(
      'fields',
      'name,adset_id,effective_status,creative{id,object_story_spec}',
    );
    url.searchParams.set('access_token', ctx.accessToken);

    const { data } = await this.http.request<MetaAdForRecreate>({
      url: url.toString(),
      method: 'GET',
      integrationId: ctx.integrationId,
    });

    return {
      name: data.name ?? 'Anúncio',
      adsetId: data.adset_id ?? null,
      storySpec: data.creative?.object_story_spec ?? null,
      /**
       * `effective_status` e não `status`: um anúncio ativo dentro de conjunto
       * pausado não está entregando, e religar o substituto o colocaria a
       * veicular onde o original não veiculava.
       */
      wasDelivering: data.effective_status === 'ACTIVE',
    };
  }

  /** Criativo novo com o texto trocado — o resto do spec é copiado inteiro. */
  private async composeCreative(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    current: { name: string; storySpec: MetaStorySpec },
  ): Promise<string> {
    const spec = structuredClone(current.storySpec);
    const linkData = spec.link_data ?? (spec.link_data = {});

    if (cmd.type === 'REPLACE_COPY') {
      linkData.message = (
        cmd.parameters as ActionParametersOf<'REPLACE_COPY'>
      ).primaryText;
    } else {
      linkData.call_to_action = {
        ...(linkData.call_to_action ?? {}),
        type: (cmd.parameters as ActionParametersOf<'REPLACE_CTA'>)
          .callToAction,
      };
    }

    const { data } = await this.http.request<{ id?: string }>({
      url: `https://graph.facebook.com/${this.apiVersion}/${ctx.externalAccountId}/adcreatives`,
      method: 'POST',
      integrationId: ctx.integrationId,
      body: {
        name: `${current.name} — texto revisado`,
        object_story_spec: JSON.stringify(spec),
        access_token: ctx.accessToken,
      },
      maxAttempts: 1,
    });

    if (!data?.id)
      throw new Error('A Meta não devolveu o id do criativo novo.');

    return data.id;
  }

  private async createAd(
    ctx: ExecutionContext,
    input: { adsetId: string; name: string; creativeId: string },
  ): Promise<string> {
    const { data } = await this.http.request<{ id?: string }>({
      url: `https://graph.facebook.com/${this.apiVersion}/${ctx.externalAccountId}/ads`,
      method: 'POST',
      integrationId: ctx.integrationId,
      body: {
        name: input.name,
        adset_id: input.adsetId,
        creative: JSON.stringify({ creative_id: input.creativeId }),
        // Nasce pausado, sempre. Ligar é o último passo, depois de o antigo
        // já estar parado.
        status: 'PAUSED',
        access_token: ctx.accessToken,
      },
      maxAttempts: 1,
    });

    if (!data?.id) throw new Error('A Meta não devolveu o id do anúncio novo.');

    return data.id;
  }

  /**
   * `POST` num id **arbitrário**, não no alvo do comando.
   *
   * `post` escreve em `cmd.target.externalId`, que é o anúncio antigo. A última
   * etapa da substituição precisa escrever no anúncio **novo**, que só passou a
   * existir durante esta execução — e confundir os dois ligaria de volta
   * exatamente o que se acabou de pausar.
   */
  private async postToEntity(
    externalId: string,
    ctx: ExecutionContext,
    body: Record<string, string>,
  ): Promise<void> {
    await this.http.request<MetaWriteResponse>({
      url: `https://graph.facebook.com/${this.apiVersion}/${externalId}`,
      method: 'POST',
      integrationId: ctx.integrationId,
      body: { ...body, access_token: ctx.accessToken },
      maxAttempts: 1,
    });
  }

  private async post(
    cmd: AdActionCommand,
    ctx: ExecutionContext,
    body: Record<string, string>,
  ): Promise<AdActionResult> {
    const url = `https://graph.facebook.com/${this.apiVersion}/${cmd.target.externalId}`;

    try {
      const response = await this.http.request<MetaWriteResponse>({
        url,
        method: 'POST',
        integrationId: ctx.integrationId,
        body: { ...body, access_token: ctx.accessToken },
        /**
         * **Uma tentativa, sempre.** O retry de escrita não pertence ao cliente
         * HTTP: repetir um `POST` que talvez tenha chegado é o caminho para
         * pausar duas vezes — inofensivo — e para somar orçamento duas vezes —
         * não. Quem decide repetir é o worker, que sabe o estado da execução e
         * carrega a chave de idempotência.
         */
        maxAttempts: 1,
      });

      return {
        status: 'SUCCEEDED',
        /**
         * Ações que recriam devolvem id novo. As quatro do subconjunto inicial
         * editam em lugar — mas ler o campo aqui é o que faz `REPLACE_*` e
         * `DUPLICATE_AD` entrarem sem mexer no caminho de execução.
         */
        ...(response.data?.id && response.data.id !== cmd.target.externalId
          ? { platformEntityId: response.data.id }
          : {}),
        raw: response.data,
        retryable: false,
      };
    } catch (error) {
      return this.classify(error, cmd, ctx);
    }
  }

  /**
   * Erro de transporte → desfecho de domínio.
   *
   * A distinção que importa é entre *"tente de novo"* e *"não adianta tentar"*.
   * `PlatformHttpClient` já classificou por status e `Retry-After`; o que falta
   * aqui é separar o que a Meta **recusou** — 400 com código de negócio — do que
   * ela não conseguiu responder. Tratar recusa como falha temporária faria o
   * worker repetir três vezes uma escrita que nunca vai ser aceita, gastando
   * cota e adiando o erro que o usuário precisa ver.
   */
  private classify(
    error: unknown,
    cmd: AdActionCommand,
    ctx: ExecutionContext,
  ): AdActionResult {
    if (error instanceof PlatformRequestError) {
      const classified = error.classified;
      const rejected = PLATFORM_REFUSALS.has(classified.code);

      this.logger.warn(
        `action.platform_error type=${cmd.type} target=${cmd.target.externalId} ` +
          `attempt=${ctx.attempt} code=${classified.code} status=${classified.status ?? ''}`,
      );

      return {
        status: rejected ? 'REJECTED_BY_PLATFORM' : 'FAILED',
        errorCode: classified.code,
        errorMessage: classified.message,
        retryable: !rejected && classified.retryable,
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
 * Os erros que significam *"a Meta olhou e disse não"* — distintos dos que
 * significam *"a Meta não respondeu"*.
 *
 * `auth` está aqui apesar de parecer temporário: token inválido não melhora com
 * repetição, e a recuperação é reconectar a integração, não tentar de novo.
 * Repetir sobre `auth` gastaria as três tentativas para chegar ao mesmo lugar,
 * um minuto mais tarde.
 */
const PLATFORM_REFUSALS = new Set<string>([
  'bad_request',
  'permission',
  'not_found',
  'auth',
]);

type MetaWriteResponse = { id?: string; success?: boolean };

type MetaStorySpec = {
  link_data?: {
    message?: string;
    call_to_action?: { type?: string; value?: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

type MetaAdForRecreate = {
  name?: string;
  adset_id?: string;
  effective_status?: string;
  creative?: { id?: string; object_story_spec?: MetaStorySpec };
};

/** `/copies` devolve o id novo num de dois campos, conforme a versão. */
type MetaCopyResponse = { copied_ad_id?: string; ad_object_id?: string };

type MetaEntityNode = {
  id: string;
  status?: string;
  effective_status?: string;
  daily_budget?: string;
  lifetime_budget?: string;
};

const OBSERVE_FIELDS: Record<string, string> = {
  AD: 'id,status,effective_status',
  AD_SET: 'id,status,effective_status,daily_budget,lifetime_budget',
  CAMPAIGN: 'id,status,effective_status,daily_budget,lifetime_budget',
};

/**
 * Ação → status que ela pede à Meta.
 *
 * `DELETED` não aparece de propósito: a Meta o produz por `DELETE`, é
 * irreversível, e o produto não o oferece. Um mapa que o incluísse tornaria
 * "apagar para sempre" alcançável por um tipo de ação.
 */
const STATUS_BY_ACTION: Partial<Record<AdActionType, string>> = {
  PAUSE_AD: 'PAUSED',
  PAUSE_AD_SET: 'PAUSED',
  PAUSE_CAMPAIGN: 'PAUSED',
  ENABLE_AD: 'ACTIVE',
  ENABLE_AD_SET: 'ACTIVE',
  ENABLE_CAMPAIGN: 'ACTIVE',
  ARCHIVE_AD: 'ARCHIVED',
};

/**
 * §13.1 traduzido para o que **esta implementação** faz hoje.
 *
 * `requiresRecreate` segue `PlatformProfile.identity.recreatesOn` da Meta: trocar
 * copy ou criativo cria anúncio novo e arquiva o antigo. As três entram no
 * sprint pela segunda metade — declará-las agora com `supported: false` e motivo
 * é o que impede a tela de oferecer o que o gateway ainda não faz.
 */
const CAPABILITIES: AdActionCapability[] = [
  {
    type: 'PAUSE_AD',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    type: 'ENABLE_AD',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    type: 'ADJUST_AD_SET_BUDGET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    /**
     * Só a plataforma sabe se este conjunto está sob CBO — e sob CBO ele não
     * aceita orçamento próprio. É o caso que dá lastro a `validationDepth`.
     */
    validationDepth: 'PLATFORM',
    constraints: { rejectedUnderCampaignBudgetOptimization: true },
  },
  {
    type: 'ADJUST_CAMPAIGN_BUDGET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
  },
  {
    type: 'PAUSE_AD_SET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    type: 'ENABLE_AD_SET',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    type: 'PAUSE_CAMPAIGN',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    type: 'ENABLE_CAMPAIGN',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    /**
     * Irreversível por §13.1: `inverseActionOf` devolve `null`, e a UI recebe
     * `irreversible: true` de `resolveAvailability` **antes** da confirmação —
     * não depois. A proteção não é a ação estar indisponível; é o usuário saber
     * que não há volta, somada à exigência de `actions:execute_sensitive`.
     */
    type: 'ARCHIVE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'LOCAL_ONLY',
  },
  {
    /**
     * `requiresRecreate: false` e `createsEntity: true`, e a combinação é a
     * informação: duplicar **não** substitui o anúncio original — ele continua
     * veiculando ao lado da cópia. Marcá-la como recriadora faria a tela avisar
     * que o aprendizado reinicia e a prova social zera, quando nada disso
     * acontece com o anúncio que o usuário está olhando.
     *
     * Campanhas Advantage+ recusam `/copies` desde a v24 da Marketing API; a
     * recusa chega como `REJECTED_BY_PLATFORM`, com o motivo da Meta.
     */
    type: 'DUPLICATE_AD',
    supported: true,
    reversible: false,
    requiresRecreate: false,
    createsEntity: true,
    validationDepth: 'PLATFORM',
    constraints: { rejectedOnAdvantagePlusCampaigns: true },
  },
  {
    /**
     * §13.1: na Meta isto é **atualização do anúncio** com outro `creative_id`.
     * O `ad_id` permanece, então não há recriação nem entidade nova — e não há
     * sucessor para a linhagem esperar.
     *
     * O aviso de aprendizado e prova social continua existindo: ele é
     * `ActionImpact`, e vem do `PlatformProfile`. Foi por conflar as duas coisas
     * num booleano que esta ação constava como recriadora até A2-S8.
     */
    type: 'REPLACE_CREATIVE',
    supported: true,
    reversible: true,
    requiresRecreate: false,
    createsEntity: false,
    validationDepth: 'PLATFORM',
  },
  {
    /**
     * Criativo da Meta é imutável: trocar texto compõe um criativo novo e
     * substitui o anúncio. O `ad_id` muda, há sucessor, e a linhagem herda.
     *
     * `reversible: false` apesar de §13.1 dizer "sim": o que se restauraria é o
     * texto anterior, e ele não está em `previousState` — que guarda status e
     * orçamento. Prometer reversão que o estado capturado não sustenta seria
     * pior que não prometê-la.
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
];
