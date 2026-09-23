import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { AdUnitKind } from '../ad-unit';
import {
  AdActionType,
  AdStatus,
  CopyField,
  CopyFieldProfile,
  FormatScope,
  MetricField,
  PlatformProfile,
} from './platform-profile';
import {
  ActionImpact,
  ActionMutation,
  DEFAULT_MUTATION,
  impactOf,
} from './mutation-strategy';

const META: PlatformProfile = {
  platform: 'META',
  hierarchy: {
    hasAdSetLevel: true,
    adSetLabel: 'Conjunto de anúncios',
    budgetLevels: ['AD_SET', 'CAMPAIGN'],
    // Advantage+ campaign budget: com CBO ligado, mexer no orçamento do conjunto
    // não faz nada, e a ação tem que subir para a campanha (§9.2).
    cboAware: true,
    // A Meta não expõe pacote de recursos como unidade: o Advantage+ continua
    // entregando anúncios. O rótulo existe para o tipo ser total.
    unitLabels: { AD: 'anúncio', ASSET_GROUP: 'pacote de recursos' },
  },
  status: {
    toCanonical: {
      ACTIVE: 'ACTIVE',
      PAUSED: 'PAUSED',
      DELETED: 'DELETED',
      ARCHIVED: 'ARCHIVED',
      PENDING_REVIEW: 'PENDING_REVIEW',
      DISAPPROVED: 'DISAPPROVED',
      PREAPPROVED: 'PENDING_REVIEW',
      PENDING_BILLING_INFO: 'PENDING_REVIEW',
      CAMPAIGN_PAUSED: 'PAUSED',
      ADSET_PAUSED: 'PAUSED',
    },
    irreversible: ['DELETED'],
  },
  metrics: {
    available: [
      'spend',
      'impressions',
      'clicks',
      'conversions',
      'revenue',
      'reach',
      'frequency',
      'videoViews',
      'engagement',
      'thumbstopRate',
      'holdRate',
      'hides',
      'hideAllFor',
      'reports',
      'unlikes',
    ],
    unavailable: {},
  },
  sync: { supportsUpdatedSince: true, exposesDataTimestamp: true },
  /**
   * **A Meta troca o texto principal e o CTA — e mais nada, hoje.**
   *
   * `composeCreative()` no gateway clona o `object_story_spec` e sobrescreve
   * `link_data.message` (texto principal) ou `link_data.call_to_action.type`
   * (CTA). Título e descrição vivem no mesmo spec e **não** são tocados: a
   * composição precisaria ser estendida, e prometer aplicá-los antes disso
   * seria a ação com parâmetro sem destino que F7.7 registra.
   */
  copy: {
    primaryText: {
      writableBy: 'REPLACE_COPY',
      maxLength: null,
      minLength: 1,
      // A Meta corta com "Ver mais" por volta daqui. Passar não quebra a
      // chamada — só faz o benefício principal ficar atrás de um clique.
      recommendedLength: 125,
      allowedValues: null,
    },
    headline: {
      writableBy: null,
      maxLength: null,
      minLength: null,
      recommendedLength: 40,
      allowedValues: null,
      unavailableReason:
        'A troca de texto na Meta recompõe o criativo sobrescrevendo apenas o ' +
        'texto principal. Aplicar o título exige estender a composição — até ' +
        'lá, ele é gerado para uso no gerenciador.',
    },
    description: {
      writableBy: null,
      maxLength: null,
      minLength: null,
      recommendedLength: 30,
      allowedValues: null,
      unavailableReason:
        'Mesmo motivo do título: a composição do criativo novo troca só o ' +
        'texto principal.',
    },
    callToAction: {
      writableBy: 'REPLACE_CTA',
      maxLength: null,
      minLength: null,
      recommendedLength: null,
      /**
       * **Enum, não prosa.** `call_to_action.type` aceita um valor da lista da
       * Meta; qualquer outra coisa é recusada na chamada. Sem esta lista, a
       * geração produziria uma frase, a tela a exibiria como texto bonito, e a
       * recusa só apareceria no envio.
       */
      allowedValues: [
        'LEARN_MORE',
        'SHOP_NOW',
        'SIGN_UP',
        'SUBSCRIBE',
        'BOOK_TRAVEL',
        'CONTACT_US',
        'DOWNLOAD',
        'GET_OFFER',
        'GET_QUOTE',
        'APPLY_NOW',
        'SEE_MENU',
        'SEND_MESSAGE',
        'WATCH_MORE',
        'NO_BUTTON',
      ],
    },
  },

  identity: {
    /**
     * §13.1 para a Meta. `REPLACE_CREATIVE` é **edição em lugar**: o `ad_id`
     * permanece, e a chamada é uma atualização do anúncio com outro
     * `creative_id`. Ele constava como recriação até A2-S8, e a confusão
     * custava caro — a linhagem criaria um sucessor que a plataforma nunca
     * criou, e o outcome mediria uma migração de gasto que não houve.
     *
     * O que continua verdadeiro é o **impacto**: o post muda, a prova social
     * acumulada se perde e o aprendizado reinicia. É isso que a tela avisa
     * antes da confirmação, e agora vem de `ActionImpact`, não da estratégia.
     */
    mutation: {
      REPLACE_CREATIVE: {
        strategy: 'PATCH',
        resetsLearning: true,
        losesSocialProof: true,
      },
      // Texto vive no criativo: mudá-lo exige criativo novo, e a Meta troca o
      // anúncio junto. Aqui o id **muda**, e há sucessor.
      REPLACE_COPY: {
        strategy: 'RECREATE',
        resetsLearning: true,
        losesSocialProof: true,
      },
      REPLACE_CTA: {
        strategy: 'RECREATE',
        resetsLearning: true,
        losesSocialProof: true,
      },
      // Irmão, não sucessor: o original segue veiculando, e o aprendizado dele
      // não é tocado. Quem começa do zero é a cópia — e ela já nasce sem série.
      DUPLICATE_AD: { strategy: 'DUPLICATE' },
    },
  },
};

const GOOGLE: PlatformProfile = {
  platform: 'GOOGLE',
  hierarchy: {
    hasAdSetLevel: true,
    adSetLabel: 'Grupo de anúncios',
    budgetLevels: ['CAMPAIGN'],
    cboAware: false,
    unitLabels: { AD: 'anúncio', ASSET_GROUP: 'grupo de recursos' },
  },
  status: {
    toCanonical: {
      ENABLED: 'ACTIVE',
      PAUSED: 'PAUSED',
      REMOVED: 'DELETED',
      UNKNOWN: 'UNKNOWN',
      UNSPECIFIED: 'UNKNOWN',
      // O Google não tem `effective_status`: estes dois são compostos por
      // `googleDeliveryStatus` a partir da política do anúncio.
      DISAPPROVED: 'DISAPPROVED',
      PENDING_REVIEW: 'PENDING_REVIEW',
    },
    // `REMOVED` no Google não volta. É o exemplo que a v2.0 usa para exigir que
    // a irreversibilidade seja declarada e mostrada antes da confirmação.
    irreversible: ['DELETED'],
  },
  metrics: {
    /**
     * `thumbstopRate`/`holdRate` entraram aqui a partir do quartil de
     * visualização de vídeo (`video_quartile_p25/p100_rate`) — medível no
     * anúncio de vídeo, **não** no de busca ou display. Declarar por
     * plataforma e não por formato é a mesma simplificação que a Meta e o
     * TikTok já faziam para os dois sinais: quem neutraliza o formato que não
     * produz vídeo é o teto de cobertura sem vídeo (`nonVideoCoverageMaxFor`,
     * §12.4 dívida B7-bis), não esta lista.
     */
    available: [
      'spend',
      'impressions',
      'clicks',
      'conversions',
      'revenue',
      'videoViews',
      'engagement',
      'thumbstopRate',
      'holdRate',
    ],
    // O motivo é declarado porque ele vai para a tela: um componente ausente
    // reduz a confiança do score e o usuário precisa saber por quê (P7, D11).
    unavailable: {
      frequency:
        'Search não expõe frequência: não há entrega repetida por pessoa.',
      reach: 'Alcance deduplicado não é exposto por padrão na API de Search.',
      hides: 'Google não expõe sinal de feedback negativo por anúncio.',
      hideAllFor: 'Google não expõe sinal de feedback negativo por anúncio.',
      reports: 'Google não expõe sinal de feedback negativo por anúncio.',
      unlikes: 'Google não expõe sinal de feedback negativo por anúncio.',
    },
  },
  sync: { supportsUpdatedSince: false, exposesDataTimestamp: false },
  /**
   * **Search não tem texto principal, e o limite de título é duro.**
   *
   * O anúncio responsivo é composto por títulos e descrições, e a API **recusa**
   * acima de 30 e 90 caracteres — não trunca. É a diferença que separa
   * `maxLength` de `recommendedLength`, e é por isso que o campo existe: na Meta
   * passar do recomendado deixa o texto feio; aqui, derruba a chamada.
   *
   * Título e descrição são escritos por `REPLACE_COPY` **sobre um asset
   * escolhido** (`assetReplacement`): o texto gerado substitui um título ou uma
   * descrição específicos, e os demais assets do anúncio ficam como estão.
   *
   * **Cada campo vale para um formato.** Título e descrição, como assets
   * escolhidos, só no anúncio de busca responsivo. A chamada para ação só
   * existe onde o anúncio a tem como texto: responsivo de display e Demand Gen
   * de várias imagens ou carrossel. O vídeo e o produto do Demand Gen a guardam
   * como asset de CTA — trocá-la exigiria criar asset, e ficam de fora.
   */
  copy: {
    primaryText: {
      writableBy: null,
      maxLength: null,
      minLength: null,
      recommendedLength: null,
      allowedValues: null,
      unavailableReason:
        'Search não tem texto principal: o anúncio é composto por títulos e ' +
        'descrições.',
    },
    headline: {
      writableBy: 'REPLACE_COPY',
      maxLength: 30,
      minLength: 1,
      recommendedLength: 30,
      allowedValues: null,
      writableFormats: {
        formats: ['RESPONSIVE_SEARCH_AD'],
        label: 'anúncios de busca responsivos',
      },
    },
    description: {
      writableBy: 'REPLACE_COPY',
      maxLength: 90,
      minLength: 1,
      recommendedLength: 90,
      allowedValues: null,
      writableFormats: {
        formats: ['RESPONSIVE_SEARCH_AD'],
        label: 'anúncios de busca responsivos',
      },
    },
    /**
     * Texto livre, não enum como na Meta e no TikTok: `call_to_action_text`.
     * 30 é a largura máxima que o Google declara para o campo no display
     * responsivo, aplicada aos três formatos por ser o limite conhecido mais
     * estreito.
     */
    callToAction: {
      writableBy: 'REPLACE_CTA',
      maxLength: 30,
      minLength: 1,
      recommendedLength: 30,
      allowedValues: null,
      writableFormats: {
        formats: [
          'RESPONSIVE_DISPLAY_AD',
          'DEMAND_GEN_MULTI_ASSET_AD',
          'DEMAND_GEN_CAROUSEL_AD',
        ],
        label:
          'anúncios responsivos de display e Demand Gen de várias imagens ou carrossel',
      },
    },
  },

  identity: {
    /**
     * §13.1 para o Google: texto é campo do anúncio e se edita em lugar; trocar
     * o **ativo** criativo, não. Anúncio de busca não tem prova social a perder
     * — não há post, curtida nem comentário —, e é por isso que
     * `losesSocialProof` fica de fora aqui e não em TikTok.
     */
    mutation: {
      REPLACE_CREATIVE: { strategy: 'RECREATE', resetsLearning: true },
      REPLACE_COPY: { strategy: 'PATCH', resetsLearning: true },
      REPLACE_CTA: { strategy: 'PATCH', resetsLearning: true },
      DUPLICATE_AD: { strategy: 'DUPLICATE' },
    },
  },
};

const TIKTOK: PlatformProfile = {
  platform: 'TIKTOK',
  hierarchy: {
    hasAdSetLevel: true,
    adSetLabel: 'Grupo de anúncios',
    budgetLevels: ['AD_SET', 'CAMPAIGN'],
    cboAware: true,
    unitLabels: { AD: 'anúncio', ASSET_GROUP: 'anúncio Smart+' },
  },
  status: {
    toCanonical: {
      // `operation_status` — a chave liga/desliga do próprio objeto.
      ENABLE: 'ACTIVE',
      DISABLE: 'PAUSED',
      DELETE: 'DELETED',
      // Encerrado: "não pode ser ligado de novo". Terminal, como o arquivamento.
      FROZEN: 'ARCHIVED',
      AUDIT: 'PENDING_REVIEW',
      REAUDIT: 'PENDING_REVIEW',
      AUDIT_DENY: 'DISAPPROVED',

      /**
       * `secondary_status` (v1.3) — o que de fato entrega, e o que o sync e a
       * verificação leem (`tiktokDeliveryStatus`). Sem estas chaves todo
       * anúncio do TikTok virava `UNKNOWN`.
       *
       * Orçamento ou saldo esgotado é **ativo**: a entrega volta sozinha no
       * dia seguinte, e chamá-la de pausa faria a reconciliação acusar drift
       * sobre um anúncio que ninguém pausou. Bloqueios sem equivalente
       * canônico — autorização de música, pixel desvinculado, produto
       * indisponível — ficam de fora de propósito e caem em `UNKNOWN`.
       */
      AD_STATUS_DELIVERY_OK: 'ACTIVE',
      AD_STATUS_OK: 'ACTIVE',
      AD_STATUS_EXPLORING: 'ACTIVE',
      AD_STATUS_UNEXPLORED: 'ACTIVE',
      AD_STATUS_GOOD: 'ACTIVE',
      AD_STATUS_BAD: 'ACTIVE',
      AD_STATUS_BALANCE_EXCEED: 'ACTIVE',
      AD_STATUS_BUDGET_EXCEED: 'ACTIVE',
      AD_STATUS_CAMPAIGN_EXCEED: 'ACTIVE',
      AD_STATUS_DELIVERY_AND_REAUDIT: 'ACTIVE',
      AD_STATUS_PARTIAL_AUDIT_DELIVERY_OK: 'ACTIVE',
      AD_STATUS_REVIEW_PARTIALLY_APPROVED: 'ACTIVE',
      AD_STATUS_NOT_START: 'PAUSED',
      AD_STATUS_DONE: 'PAUSED',
      AD_STATUS_DISABLE: 'PAUSED',
      AD_STATUS_CAMPAIGN_DISABLE: 'PAUSED',
      AD_STATUS_ADGROUP_DISABLE: 'PAUSED',
      AD_STATUS_DELETE: 'DELETED',
      AD_STATUS_CAMPAIGN_DELETE: 'DELETED',
      AD_STATUS_ADGROUP_DELETE: 'DELETED',
      AD_STATUS_AUDIT: 'PENDING_REVIEW',
      AD_STATUS_REAUDIT: 'PENDING_REVIEW',
      AD_STATUS_ADVERTISER_AUDIT: 'PENDING_REVIEW',
      AD_STATUS_PRIVACY_POLICY_AUDIT: 'PENDING_REVIEW',
      AD_STATUS_AUDIT_DENY: 'DISAPPROVED',
      AD_STATUS_ADGROUP_AUDIT_DENY: 'DISAPPROVED',
      AD_STATUS_ADVERTISER_AUDIT_DENY: 'DISAPPROVED',
      AD_STATUS_PRIVACY_POLICY_REJECTED: 'DISAPPROVED',

      ADGROUP_STATUS_DELIVERY_OK: 'ACTIVE',
      ADGROUP_STATUS_BALANCE_EXCEED: 'ACTIVE',
      ADGROUP_STATUS_BUDGET_EXCEED: 'ACTIVE',
      ADGROUP_STATUS_CAMPAIGN_EXCEED: 'ACTIVE',
      ADGROUP_STATUS_NOT_START: 'PAUSED',
      ADGROUP_STATUS_TIME_DONE: 'PAUSED',
      ADGROUP_STATUS_DISABLE: 'PAUSED',
      ADGROUP_STATUS_CAMPAIGN_DISABLE: 'PAUSED',
      ADGROUP_STATUS_DELETE: 'DELETED',
      ADGROUP_STATUS_CAMPAIGN_DELETE: 'DELETED',
      ADGROUP_STATUS_FROZEN: 'ARCHIVED',
      ADGROUP_STATUS_AUDIT: 'PENDING_REVIEW',
      ADGROUP_STATUS_REAUDIT: 'PENDING_REVIEW',
      ADGROUP_STATUS_AUDIT_DENY: 'DISAPPROVED',

      CAMPAIGN_STATUS_ENABLE: 'ACTIVE',
      CAMPAIGN_STATUS_BUDGET_EXCEED: 'ACTIVE',
      CAMPAIGN_STATUS_DISABLE: 'PAUSED',
      CAMPAIGN_STATUS_DELETE: 'DELETED',
    },
    irreversible: ['DELETED', 'ARCHIVED'],
  },
  metrics: {
    available: [
      'spend',
      'impressions',
      'clicks',
      'conversions',
      'revenue',
      'reach',
      'frequency',
      'videoViews',
      'engagement',
      'thumbstopRate',
      'holdRate',
    ],
    unavailable: {
      hides: 'TikTok não expõe ocultações por anúncio na Marketing API.',
      hideAllFor: 'TikTok não expõe ocultações por anunciante.',
      reports: 'TikTok não expõe denúncias por anúncio.',
      unlikes: 'TikTok não expõe descurtidas por anúncio.',
    },
  },
  sync: { supportsUpdatedSince: true, exposesDataTimestamp: false },
  /**
   * **O TikTok tem um campo de texto só, e ele tem mínimo.**
   *
   * `ad_text` vai de 12 a 100 caracteres, e a API recusa nos dois extremos — é a
   * única plataforma das três com piso. Título e descrição não existem como
   * campos separados.
   *
   * Texto e CTA são escritos recriando o anúncio (ver `identity.mutation`): o
   * novo nasce pausado, o antigo é pausado, e só então o novo é ligado.
   */
  copy: {
    primaryText: {
      writableBy: 'REPLACE_COPY',
      maxLength: 100,
      minLength: 12,
      recommendedLength: 100,
      allowedValues: null,
    },
    headline: {
      writableBy: null,
      maxLength: null,
      minLength: null,
      recommendedLength: null,
      allowedValues: null,
      unavailableReason:
        'O TikTok não separa título do texto do anúncio: há um campo só.',
    },
    description: {
      writableBy: null,
      maxLength: null,
      minLength: null,
      recommendedLength: null,
      allowedValues: null,
      unavailableReason:
        'O TikTok não separa descrição do texto do anúncio: há um campo só.',
    },
    callToAction: {
      writableBy: 'REPLACE_CTA',
      maxLength: null,
      minLength: null,
      recommendedLength: null,
      // Enum, nunca texto livre: a variação traz um valor da lista, não uma frase.
      allowedValues: [
        'LEARN_MORE',
        'SHOP_NOW',
        'SIGN_UP',
        'DOWNLOAD_NOW',
        'CONTACT_US',
        'APPLY_NOW',
        'BOOK_NOW',
        'WATCH_NOW',
      ],
    },
  },

  identity: {
    /**
     * §13.1 para o TikTok: as três substituições recriam. `REPLACE_CTA`
     * constava como edição em lugar até A2-S8 — divergência do documento, e a
     * direção do erro era a cara: prometia preservar um anúncio que a
     * plataforma iria substituir.
     */
    mutation: {
      REPLACE_CREATIVE: {
        strategy: 'RECREATE',
        resetsLearning: true,
        losesSocialProof: true,
      },
      REPLACE_COPY: {
        strategy: 'RECREATE',
        resetsLearning: true,
        losesSocialProof: true,
      },
      REPLACE_CTA: {
        strategy: 'RECREATE',
        resetsLearning: true,
        losesSocialProof: true,
      },
      DUPLICATE_AD: { strategy: 'DUPLICATE' },
    },
  },
};

/**
 * O mapa é exaustivo por construção: `Record<Platform, …>` faz `tsc` acusar a
 * plataforma nova que ninguém perfilou. É essa exaustividade que substitui a
 * varredura por `if (platform === …)` que P6 proíbe — e é ela que torna
 * LinkedIn, Pinterest e Amazon (§20 H4) configuração, não refatoração.
 */
export const PLATFORM_PROFILES: Readonly<Record<Platform, PlatformProfile>> = {
  META,
  GOOGLE,
  TIKTOK,
};

export function platformProfile(platform: Platform): PlatformProfile {
  return PLATFORM_PROFILES[platform];
}

/** Como a plataforma chama a unidade — ver `hierarchy.unitLabels`. */
export function unitLabelOf(platform: Platform, unitKind: AdUnitKind): string {
  return PLATFORM_PROFILES[platform].hierarchy.unitLabels[unitKind];
}

/**
 * Status cru → canônico. Desconhecido vira `UNKNOWN`, nunca `ACTIVE`: assumir
 * que um estado não mapeado está veiculando é como o produto passaria a
 * recomendar pausar um anúncio que a plataforma já reprovou.
 */
export function toCanonicalStatus(
  platform: Platform,
  rawStatus: string,
): AdStatus {
  const profile = PLATFORM_PROFILES[platform];
  const key = rawStatus.toUpperCase();
  const mapped = profile.status.toCanonical[key];

  if (mapped) return mapped;

  /**
   * Um valor que **já é canônico** passa como está.
   *
   * O `previousState` do enfileiramento guarda o status canônico do anúncio
   * (`ACTIVE`, `PAUSED`), e a reversão o traduz de novo por aqui. Na Meta os dois
   * vocabulários coincidem; no Google e no TikTok, `ACTIVE` não é status cru,
   * virava `UNKNOWN`, e reverter uma pausa era recusado só nessas plataformas.
   */
  return CANONICAL_STATUSES.has(key) ? (key as AdStatus) : 'UNKNOWN';
}

const CANONICAL_STATUSES: ReadonlySet<string> = new Set<AdStatus>([
  'ACTIVE',
  'PAUSED',
  'ARCHIVED',
  'DELETED',
  'PENDING_REVIEW',
  'DISAPPROVED',
  'UNKNOWN',
]);

/**
 * Quantos dos sinais que o score usa a plataforma de fato entrega.
 *
 * É o denominador de `coverageRatio` (D11): os pisos de §12.4 incidem sobre a
 * cobertura **relativa ao perfil**, não sobre a absoluta. Com piso absoluto, um
 * anúncio de Search — que nunca terá frequência nem feedback negativo — ficaria
 * fora de toda ordenação e de todo alerta, e o produto multi-plataforma sumiria
 * da tela que o define.
 */
export function platformCoverageMax(
  platform: Platform,
  weightedFields: Partial<Record<MetricField, number>>,
): number {
  const profile = PLATFORM_PROFILES[platform];
  const available = new Set(profile.metrics.available);

  let total = 0;
  let covered = 0;
  for (const [field, weight] of Object.entries(weightedFields)) {
    total += weight ?? 0;
    if (available.has(field as MetricField)) covered += weight ?? 0;
  }

  return total === 0 ? 0 : covered / total;
}

/** O perfil de um campo de texto nesta plataforma. */
export function copyFieldProfile(
  platform: Platform,
  field: CopyField,
): CopyFieldProfile {
  return PLATFORM_PROFILES[platform].copy[field];
}

/**
 * O texto cabe no campo **desta** plataforma?
 *
 * Devolve o motivo em vez de um booleano porque quem chama precisa dizê-lo: a
 * geração usa para reescrever, a tela para avisar antes do envio, e a validação
 * de ação para recusar com uma frase que a pessoa entenda. Um `false` faria os
 * três inventarem a explicação, e a inventada é sempre "texto inválido".
 */
export function checkCopyLength(
  platform: Platform,
  field: CopyField,
  text: string,
): { fits: true } | { fits: false; reason: string } {
  const profile = copyFieldProfile(platform, field);
  const length = text.trim().length;

  if (profile.maxLength !== null && length > profile.maxLength) {
    return {
      fits: false,
      reason: `${length} caracteres: a plataforma recusa acima de ${profile.maxLength}.`,
    };
  }

  if (profile.minLength !== null && length < profile.minLength) {
    return {
      fits: false,
      reason: `${length} caracteres: a plataforma recusa abaixo de ${profile.minLength}.`,
    };
  }

  /**
   * Valor fora do enum é recusa, não aviso.
   *
   * O caso vivo é o CTA da Meta: `call_to_action.type` aceita a lista do perfil
   * e nada mais. Uma frase ali é uma chamada que a plataforma rejeita — e sem
   * esta checagem ela chegaria bonita à tela e morreria no envio.
   */
  if (profile.allowedValues && !profile.allowedValues.includes(text.trim())) {
    return {
      fits: false,
      reason:
        `"${text.trim()}" não é um valor aceito neste campo. A plataforma ` +
        `aceita apenas: ${profile.allowedValues.join(', ')}.`,
    };
  }

  return { fits: true };
}

/**
 * O campo é escrevível **neste anúncio**?
 *
 * `writableBy` responde pela plataforma; esta função responde pelo anúncio, que
 * é a pergunta que a tela, a recomendação e a execução de fato fazem. As três
 * leem daqui para não divergirem: um CTA "aplicável" no Copy Studio que o
 * dry-run recusa é a mesma promessa quebrada de F7.7, só que mais tarde.
 *
 * `format` nulo — criativo ainda não lido — recusa onde há recorte: prometer a
 * escrita sem saber o formato é adivinhar.
 */
export function copyFieldWritability(
  platform: Platform,
  field: CopyField,
  format: string | null,
):
  | { writable: true; writableBy: AdActionType }
  | { writable: false; reason: string } {
  const profile = copyFieldProfile(platform, field);

  if (profile.writableBy === null) {
    return {
      writable: false,
      reason:
        profile.unavailableReason ??
        'A plataforma não permite escrever este campo.',
    };
  }

  const scope = profile.writableFormats;

  if (scope && !inFormatScope(scope, format)) {
    return { writable: false, reason: formatScopeRefusal(scope, format) };
  }

  return { writable: true, writableBy: profile.writableBy };
}

export function inFormatScope(
  scope: FormatScope,
  format: string | null,
): boolean {
  return format !== null && scope.formats.includes(format);
}

/** A frase da recusa por formato — a mesma no Copy Studio e nas ações. */
export function formatScopeRefusal(
  scope: FormatScope,
  format: string | null,
): string {
  return format
    ? `Vale para ${scope.label}; este anúncio é ${format}.`
    : `Vale para ${scope.label}; o formato deste anúncio ainda não foi lido.`;
}

/**
 * Os campos que **alguma ação sabe escrever** nesta plataforma.
 *
 * É o que separa "gerado" de "aplicável". Os demais continuam sendo gerados —
 * servem ao gerenciador —, e é a tela que declara a diferença em vez de
 * escondê-la.
 */
export function writableCopyFields(platform: Platform): CopyField[] {
  const copy = PLATFORM_PROFILES[platform].copy;

  return (Object.keys(copy) as CopyField[]).filter(
    (field) => copy[field].writableBy !== null,
  );
}

/**
 * A estratégia de mutação de uma ação **nesta plataforma**.
 *
 * Platform-aware de propósito: `REPLACE_CREATIVE` é edição na Meta e recriação
 * no Google. Uma lista global — que é o que `RECREATING_ACTIONS` era — só pode
 * acertar uma das duas.
 */
export function mutationFor(
  platform: Platform,
  actionType: AdActionType,
): ActionMutation {
  return (
    PLATFORM_PROFILES[platform].identity.mutation[actionType] ??
    DEFAULT_MUTATION
  );
}

/** *"A plataforma exige criar um recurso novo no lugar deste?"* — e só isso. */
export function requiresRecreate(
  platform: Platform,
  actionType: AdActionType,
): boolean {
  return mutationFor(platform, actionType).strategy === 'RECREATE';
}

/** O que a mudança faz com a entrega — a outra pergunta, agora separada. */
export function actionImpactFor(
  platform: Platform,
  actionType: AdActionType,
): ActionImpact {
  return impactOf(mutationFor(platform, actionType));
}
