import type { RecommendationKind } from './contracts/recommendation-catalog';

/**
 * Supressões (§9.4 passo 3d).
 *
 * > **O passo 3d mantém o motor vivo.** Um motor que reapresenta amanhã o que o
 * > usuário rejeitou hoje não morre por errar — morre por não escutar.
 *
 * A taxa de dispensa por `kind` é métrica de produto: assim como `USER_DIRECT`
 * sinaliza recomendação faltante (P3), dispensa recorrente sinaliza política
 * errada (P8).
 */

export type SuppressionScope = 'AD' | 'AD_SET' | 'CAMPAIGN' | 'ORGANIZATION';

export type ActiveSuppression = {
  id: string;
  kind: RecommendationKind;
  scope: SuppressionScope;
  /** `null` quando o escopo é `ORGANIZATION` — não há id a casar. */
  scopeId: string | null;
  /** `null` = permanente. */
  expiresAt: Date | null;
  reason: string;
};

export type SuppressionTarget = {
  kind: RecommendationKind;
  adId: string;
  adSetId: string | null;
  campaignId: string;
};

/**
 * A supressão que silencia este plano, ou `null`.
 *
 * O escopo é hierárquico e **do mais amplo para o mais específico** na leitura,
 * mas a busca devolve a primeira que casa: uma supressão de organização vale
 * para todo anúncio dela, e ter dispensado o kind no anúncio não deveria ser
 * necessário depois de tê-lo dispensado na conta inteira.
 */
export function findSuppression(
  target: SuppressionTarget,
  suppressions: ActiveSuppression[],
  now: Date,
): ActiveSuppression | null {
  for (const suppression of suppressions) {
    if (suppression.kind !== target.kind) continue;
    // Expirada não suprime. O job de ciclo de vida as remove, mas a leitura não
    // pode depender de ele ter rodado — senão uma supressão de 7 dias silencia
    // por 8 quando o cron atrasa.
    if (suppression.expiresAt && suppression.expiresAt <= now) continue;

    if (suppression.scope === 'ORGANIZATION') return suppression;
    if (suppression.scope === 'AD' && suppression.scopeId === target.adId) {
      return suppression;
    }
    if (
      suppression.scope === 'AD_SET' &&
      target.adSetId !== null &&
      suppression.scopeId === target.adSetId
    ) {
      return suppression;
    }
    if (
      suppression.scope === 'CAMPAIGN' &&
      suppression.scopeId === target.campaignId
    ) {
      return suppression;
    }
  }

  return null;
}

/** Prazo padrão de uma dispensa, quando o usuário não declara um. */
export const DEFAULT_SUPPRESSION_DAYS = 30;

/**
 * O escopo que uma dispensa cria por padrão: **o anúncio**.
 *
 * Dispensar uma recomendação é dizer "não neste anúncio", não "nunca mais na
 * conta". Assumir o escopo mais amplo silenciaria o motor inteiro num clique, e
 * o usuário só descobriria pela ausência.
 */
export const DEFAULT_SUPPRESSION_SCOPE: SuppressionScope = 'AD';
