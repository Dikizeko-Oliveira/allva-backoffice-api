import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';
import type { ActionLevel } from 'src/modules/ads/domain/platform/platform-profile';
import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { ActionAlternative } from './contracts/recommendation-catalog';
import {
  copyFieldProfile,
  copyFieldWritability,
  requiresRecreate,
} from 'src/modules/ads/domain/platform/platform-profiles';
import type {
  AdSignal,
  PlannedAction,
  SelectedCopy,
} from './recommendation-plan';

/**
 * Resolução de nível por `PlatformProfile` (§9.2).
 *
 * A política declara alternativas **ordenadas**; esta função percorre a lista
 * contra `hierarchy.budgetLevels` e para na primeira que a plataforma suporta.
 * *"Replaneja antes de descartar"* — e descartar produz recomendação consultiva
 * com `outOfScopeReason`, nunca uma recomendação vazia e silenciosa.
 *
 * **CBO muda onde a ação incide.** Com orçamento na campanha, mexer no do
 * conjunto não faz nada: `cboAware` é o que faz a segunda alternativa vencer a
 * primeira em vez de a primeira ser executada sem efeito.
 */

export type LevelResolution =
  | { resolved: true; action: PlannedAction }
  | { resolved: false; outOfScopeReason: string };

export type BudgetIntent = {
  /** Fração do orçamento atual: `-0,3` reduz 30%, `+0,2` aumenta 20%. */
  delta: number;
  /** Quantos anúncios o conjunto/campanha carrega — vira `scopeWarning`. */
  adsInAdSet: number;
  adsInCampaign: number;
};

export function resolveAction(input: {
  alternatives: readonly ActionAlternative[];
  ad: AdSignal;
  /** Presente só para as alternativas de orçamento. */
  budget?: BudgetIntent;
  /** `REPLACE_CREATIVE` sem candidato não é alternativa viável (§11.4). */
  replacementCreativeId?: string | null;
  /**
   * A variação de copy **escolhida** para este anúncio no Copy Studio.
   *
   * É o que faz `REPLACE_COPY` e `REPLACE_CTA` deixarem de ser declaradas
   * inviáveis: até existir, elas eram ações com um parâmetro obrigatório sem
   * fonte — o mesmo defeito que §11.4 corrigiu em `REPLACE_CREATIVE`.
   *
   * **Escolhida, não gerada.** Uma geração produz três variações, e três textos
   * não são um parâmetro. A seleção é o ato explícito da pessoa, e é ela que
   * autoriza o texto a virar candidato a ir ao ar — a confirmação final do
   * conteúdo continua sendo exigida por R14 na execução.
   */
  selectedCopy?: SelectedCopy | null;
}): LevelResolution {
  const profile = platformProfile(input.ad.platform);

  for (const alternative of input.alternatives) {
    const action = tryAlternative(alternative, input, profile);
    if (action) return { resolved: true, action };
  }

  return {
    resolved: false,
    outOfScopeReason: outOfScopeReasonFor(
      input.alternatives,
      input.ad.platform,
    ),
  };
}

/**
 * A plataforma carrega orçamento neste nível?
 *
 * `ActionLevel` — `AD`/`AD_SET`/`CAMPAIGN` — é propriedade da **ação** (§9.2),
 * não da métrica. A distinção importa para além do tipo: o nível de métrica é a
 * doença que a v2.0 eliminou; o nível de ação é o que faz a recomendação sobre
 * um anúncio mexer no orçamento onde ele de fato vive.
 */
function supportsBudgetAt(
  profile: ReturnType<typeof platformProfile>,
  level: ActionLevel,
): boolean {
  return profile.hierarchy.budgetLevels.includes(level);
}

function tryAlternative(
  alternative: ActionAlternative,
  input: Parameters<typeof resolveAction>[0],
  profile: ReturnType<typeof platformProfile>,
): PlannedAction | null {
  const { ad } = input;

  if (alternative.level === 'AD_SET') {
    // Sem nível intermediário na plataforma, ou sem conjunto no anúncio: a
    // alternativa não existe. Google Search não tem ad set com orçamento
    // próprio, e forçá-la produziria uma ação que a API recusa.
    if (!profile.hierarchy.hasAdSetLevel) return null;
    if (!supportsBudgetAt(profile, 'AD_SET')) return null;
    if (!ad.adSetId) return null;
    // CBO ligado: o orçamento vive na campanha, e mexer no do conjunto não faz
    // nada. Pular para a próxima alternativa é o replanejamento de §9.2.
    if (profile.hierarchy.cboAware && ad.adSetDailyBudget === null) return null;
  }

  if (
    alternative.level === 'CAMPAIGN' &&
    !supportsBudgetAt(profile, 'CAMPAIGN')
  ) {
    return null;
  }

  if (alternative.type === 'REPLACE_CREATIVE' && !input.replacementCreativeId) {
    return null;
  }

  /**
   * `REPLACE_COPY` e `REPLACE_CTA` recebem **texto autoral**, e o parâmetro vem
   * da variação escolhida no Copy Studio.
   *
   * Eram recusadas incondicionalmente enquanto esse caminho não existia — uma
   * ação com parâmetro obrigatório sem fonte é pior que uma recomendação
   * consultiva. A recusa não sumiu: **virou condição**. Sem variação escolhida
   * para este anúncio, a alternativa continua inviável, e o kind continua
   * consultivo com o motivo declarado.
   *
   * O que muda é que agora existe um caminho para deixar de ser: gerar, ler e
   * escolher. R14 segue valendo inteira na execução — confirmação do texto
   * final por dígito, e nunca em lote.
   */
  /**
   * Plano automático só onde há **texto principal** gravável. No Google a troca
   * é de um asset que a pessoa escolhe — qual título, qual descrição —, e a
   * recomendação não escolhe por ela: ali o kind continua consultivo, e a troca
   * acontece pela aplicação direta no anúncio.
   */
  if (
    alternative.type === 'REPLACE_COPY' &&
    (!input.selectedCopy?.primaryText ||
      copyFieldProfile(input.ad.platform, 'primaryText').writableBy !==
        'REPLACE_COPY')
  ) {
    return null;
  }

  /**
   * CTA só vira ação onde ele **é campo deste anúncio**. No Google, o anúncio
   * de busca não tem chamada para ação: planejá-la ali produziria uma ação que
   * o dry-run recusa depois de a pessoa aprovar a recomendação.
   */
  if (
    alternative.type === 'REPLACE_CTA' &&
    (!input.selectedCopy?.callToAction ||
      !copyFieldWritability(ad.platform, 'callToAction', ad.creativeFormat)
        .writable)
  ) {
    return null;
  }

  return buildAction(alternative, input);
}

function buildAction(
  alternative: ActionAlternative,
  input: Parameters<typeof resolveAction>[0],
): PlannedAction | null {
  const { ad, budget } = input;

  if (alternative.type === 'PAUSE_AD') {
    return {
      type: 'PAUSE_AD',
      level: 'AD',
      targetEntityType: 'AD',
      targetEntityId: ad.adId,
      parameters: { adId: ad.adId },
      scopeWarning: null,
      reversible: true,
      requiresRecreate: false,
    };
  }

  if (alternative.type === 'REPLACE_CREATIVE') {
    return {
      type: 'REPLACE_CREATIVE',
      level: 'AD',
      targetEntityType: 'AD',
      targetEntityId: ad.adId,
      parameters: {
        adId: ad.adId,
        creativeId: input.replacementCreativeId as string,
      },
      scopeWarning:
        'Trocar o criativo recria o anúncio na plataforma: o aprendizado ' +
        'reinicia e a prova social acumulada é perdida.',
      reversible: false,
      requiresRecreate: requiresRecreate(input.ad.platform, 'REPLACE_CREATIVE'),
    };
  }

  if (
    alternative.type === 'REPLACE_COPY' ||
    alternative.type === 'REPLACE_CTA'
  ) {
    return copyAction(alternative.type, input);
  }

  if (!budget) return null;

  if (alternative.type === 'ADJUST_AD_SET_BUDGET') {
    const current = ad.adSetDailyBudget;
    if (current === null || current <= 0 || !ad.adSetId) return null;

    return {
      type: 'ADJUST_AD_SET_BUDGET',
      level: 'AD_SET',
      targetEntityType: 'AD_SET',
      targetEntityId: ad.adSetId,
      // **Moeda da conta, sempre** (M3): enviar a base moveria dinheiro real na
      // quantia errada em toda conta que não fatura na moeda-base.
      parameters: {
        adSetId: ad.adSetId,
        dailyBudget: round2(current * (1 + budget.delta)),
        previousDailyBudget: current,
        currency: ad.currency,
      },
      scopeWarning: scopeWarningFor(budget.adsInAdSet, 'conjunto'),
      reversible: true,
      requiresRecreate: false,
    };
  }

  if (alternative.type === 'ADJUST_CAMPAIGN_BUDGET') {
    const current = ad.campaignDailyBudget;
    if (current === null || current <= 0) return null;

    return {
      type: 'ADJUST_CAMPAIGN_BUDGET',
      level: 'CAMPAIGN',
      targetEntityType: 'CAMPAIGN',
      targetEntityId: ad.campaignId,
      parameters: {
        campaignId: ad.campaignId,
        dailyBudget: round2(current * (1 + budget.delta)),
        previousDailyBudget: current,
        currency: ad.currency,
      },
      scopeWarning: scopeWarningFor(budget.adsInCampaign, 'campanha'),
      reversible: true,
      requiresRecreate: false,
    };
  }

  return null;
}

/**
 * O aviso de escopo de §9.2.
 *
 * A recomendação continua sendo **sobre o anúncio** — "este anúncio está com CPA
 * alto" —, mas a ação incide acima dele. Sem o aviso, o usuário aprova achando
 * que mexe em um e mexe em oito.
 */
function scopeWarningFor(
  ads: number,
  level: 'conjunto' | 'campanha',
): string | null {
  if (ads <= 1) return null;
  const artigo = level === 'campanha' ? 'desta' : 'deste';
  return `Afeta os ${ads} anúncios ${artigo} ${level}, não apenas este.`;
}

function outOfScopeReasonFor(
  alternatives: readonly ActionAlternative[],
  platform: Platform,
): string {
  if (alternatives.length === 0) {
    return 'Esta recomendação é consultiva por escopo: a ação pertence ao gerenciador da plataforma.';
  }

  const types = [...new Set(alternatives.map((item) => item.type))].join(', ');

  return (
    `Nenhuma das ações previstas (${types}) é aplicável a este anúncio no ${platform}: ` +
    'o nível de orçamento, o substituto criativo ou o texto autoral necessário não estão disponíveis.'
  );
}

/**
 * A ação que leva o texto escolhido ao ar.
 *
 * **`aiAuthored` vem do que foi gravado na variação**, não de um `true` fixo
 * aqui: o campo diz quem escreveu, e um literal transformaria toda copy — humana
 * inclusive — em conteúdo de IA. É ele que R14 lê para exigir a confirmação do
 * texto final, e uma declaração errada em qualquer direção quebra a guarda.
 *
 * O `scopeWarning` não é decoração: na Meta, trocar texto **recria o anúncio**,
 * reinicia o aprendizado e zera a prova social. §13.3 torna esse aviso
 * obrigatório antes da confirmação, e é aqui que ele nasce.
 */
function copyAction(
  type: 'REPLACE_COPY' | 'REPLACE_CTA',
  input: Parameters<typeof resolveAction>[0],
): PlannedAction | null {
  const { ad, selectedCopy } = input;
  if (!selectedCopy) return null;

  const text =
    type === 'REPLACE_COPY'
      ? selectedCopy.primaryText
      : selectedCopy.callToAction;

  if (!text) return null;

  return {
    type,
    level: 'AD',
    targetEntityType: 'AD',
    targetEntityId: ad.adId,
    parameters: {
      adId: ad.adId,
      ...(type === 'REPLACE_COPY'
        ? { primaryText: text }
        : { callToAction: text }),
      aiAuthored: selectedCopy.aiAuthored,
    },
    scopeWarning:
      'Trocar o texto publica conteúdo sob a marca do anunciante e, nesta ' +
      'plataforma, pode recriar o anúncio — reiniciando o aprendizado e ' +
      'zerando a prova social acumulada.',
    /**
     * `reversible: false` e não por omissão: o que se restauraria é o texto
     * anterior, e ele não está em `previousState` — que guarda status e
     * orçamento. Prometer reversão que o estado capturado não sustenta é pior
     * que não prometê-la, e é a mesma nota que o gateway da Meta já registra.
     */
    reversible: false,
    requiresRecreate: requiresRecreate(ad.platform, type),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
