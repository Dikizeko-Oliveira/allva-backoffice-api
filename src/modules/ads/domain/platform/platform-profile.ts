import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdUnitKind } from '../ad-unit';
import type { MutationByAction } from './mutation-strategy';

/** Onde uma ação pode incidir. Casa com o enum `ActionLevel` do schema. */
export type ActionLevel = 'AD' | 'AD_SET' | 'CAMPAIGN';

/** Estados canônicos de veiculação. Casa com o enum `AdStatus` do schema. */
export type AdStatus =
  | 'ACTIVE'
  | 'PAUSED'
  | 'ARCHIVED'
  | 'DELETED'
  | 'PENDING_REVIEW'
  | 'DISAPPROVED'
  | 'UNKNOWN';

/** Ações que recriam a entidade na plataforma, gerando id novo. */
export type AdActionType =
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

/** Os sinais que o score pode consumir. */
export type MetricField =
  | 'spend'
  | 'impressions'
  | 'clicks'
  | 'conversions'
  | 'revenue'
  | 'reach'
  | 'frequency'
  | 'videoViews'
  | 'engagement'
  | 'thumbstopRate'
  | 'holdRate'
  | 'hides'
  | 'hideAllFor'
  | 'reports'
  | 'unlikes';

/**
 * As diferenças entre plataformas, **declaradas** (§3.3).
 *
 * P6 diz "multi-plataforma por contrato, não por condicional". Este é o
 * contrato: cada diferença tem um campo, e uma plataforma nova é uma entrada
 * neste mapa — não uma varredura atrás de `if (platform === …)` espalhados.
 *
 * `metrics.unavailable` é o campo mais importante e o menos óbvio: ele é o que
 * permite ao scoring declarar honestamente que um componente **não pode ser
 * medido** naquela plataforma (P7). Sem o perfil, o cálculo roda sobre sinal
 * ausente e reporta confiança alta — que é pior do que não pontuar.
 */
/**
 * Os campos de texto de um anúncio — **o vocabulário da geração de copy**.
 *
 * `hook` não está aqui de propósito: ele não é campo de plataforma nenhuma. É a
 * primeira linha do texto principal, e tratá-lo como campo próprio faria a
 * geração produzir um valor que nenhuma ação sabe onde escrever.
 */
export type CopyField =
  | 'primaryText'
  | 'headline'
  | 'description'
  | 'callToAction';

/**
 * O que a plataforma aceita **neste campo**, e por qual ação.
 *
 * Existe porque texto gerado sem esta declaração é recusado pela plataforma
 * **depois** de o usuário ter confirmado o conteúdo — o pior momento possível
 * para descobrir um limite. É a mesma razão de `metrics.unavailable`: a
 * diferença entre plataformas é contrato, não condicional (P6).
 */
export type CopyFieldProfile = {
  /**
   * A ação que escreve este campo. `null` significa **não escrevível hoje** — e
   * `unavailableReason` diz por quê.
   *
   * Note que `null` aqui não quer dizer "não gere": gerar título para a Meta
   * continua útil, e o usuário aplica no gerenciador. Quer dizer "não prometa
   * aplicar", que é a distinção que F7.7 existe para preservar.
   */
  writableBy: AdActionType | null;
  /** Acima disto a plataforma **recusa**. `null` = sem limite duro conhecido. */
  maxLength: number | null;
  /** Abaixo disto a plataforma recusa. `null` = sem mínimo. */
  minLength: number | null;
  /**
   * Onde a plataforma corta na exibição. Diferente de `maxLength`: passar daqui
   * não quebra a chamada, só faz o leitor ver "…".
   */
  recommendedLength: number | null;
  /**
   * O campo aceita **apenas** estes valores.
   *
   * O caso que motivou: na Meta e no TikTok, CTA é enum, não prosa. Gerar
   * "Peça sua demonstração" como `call_to_action.type` produz uma chamada que a
   * plataforma recusa — e o texto bonito na tela esconderia isso até o envio.
   */
  allowedValues: readonly string[] | null;
  /** Declarado, nunca silencioso — vai para a tela como o motivo (P7). */
  unavailableReason?: string;
  /**
   * Os formatos de anúncio em que `writableBy` vale. Ausente: vale para todo
   * anúncio da plataforma.
   *
   * Existe por causa do Google: o anúncio de busca não tem chamada para ação, e
   * o responsivo de display e o Demand Gen têm. Declarado só por plataforma, o
   * perfil tinha de escolher entre prometer CTA na busca e negá-lo no display.
   */
  writableFormats?: FormatScope;
};

/**
 * Um recorte por formato de anúncio — o `format` que o ingest grava no
 * criativo (no Google, `ad_group_ad.ad.type`).
 *
 * `label` é a frase que a recusa usa: "vale para {label}". Sem ela, a tela
 * mostraria a lista de enums da plataforma como motivo.
 */
export type FormatScope = {
  formats: readonly string[];
  label: string;
};

export type PlatformProfile = {
  platform: Platform;

  hierarchy: {
    hasAdSetLevel: boolean;
    /** Como a plataforma chama o nível intermediário, para a tela não mentir. */
    adSetLabel: string;
    budgetLevels: ActionLevel[];
    /** Orçamento na campanha (CBO/Advantage+), que muda onde a ação incide. */
    cboAware: boolean;
    /**
     * Como a plataforma chama cada unidade (D23/D24). O pacote de recursos é
     * "grupo de recursos" no Performance Max e "anúncio Smart+" no TikTok: a
     * forma é a mesma, o nome que a pessoa reconhece no gerenciador não.
     */
    unitLabels: Record<AdUnitKind, string>;
  };

  status: {
    toCanonical: Record<string, AdStatus>;
    /** Estados sem volta: a UI precisa avisar **antes** da confirmação. */
    irreversible: AdStatus[];
  };

  metrics: {
    available: MetricField[];
    /** campo → motivo declarado. O motivo é o que a tela mostra (P7). */
    unavailable: Partial<Record<MetricField, string>>;
  };

  sync: {
    supportsUpdatedSince: boolean;
    /**
     * Se a plataforma expõe o instante do dado. Alimenta `observedAsOf`; quando
     * `false`, a guarda de recência de §8.4.1 cai para o início da janela de
     * leitura como limite inferior (B4).
     */
    exposesDataTimestamp: boolean;
  };

  /**
   * Os campos de texto, com limites e com a ação que escreve cada um.
   *
   * Entrou com a geração de copy: sem ele, "gere um título" e "aplique este
   * título" pareciam a mesma capacidade em três plataformas que tratam título
   * de três formas — e uma delas nem tem o campo.
   */
  copy: Record<CopyField, CopyFieldProfile>;

  identity: {
    /**
     * Por ação: **como** a plataforma aplica a mudança, e o que ela faz com a
     * entrega. Ausente ⇒ `PATCH` sem impacto.
     *
     * Substituiu `recreatesOn: AdActionType[]`, que misturava "cria recurso
     * novo" com "atrapalha a entrega". Na Meta, trocar o criativo mantém o
     * `ad_id` **e** reinicia o aprendizado: com um booleano só, uma das duas
     * verdades tinha de ser sacrificada, e a sacrificada virava decisão errada
     * em linhagem, auditoria e confirmação do usuário.
     */
    mutation: MutationByAction;
  };
};
