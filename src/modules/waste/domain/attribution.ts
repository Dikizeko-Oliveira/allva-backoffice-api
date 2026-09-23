import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { AdWindowAggregate } from './detection-context';

/**
 * Atribuição determinística da família `AD_SET` (§10.3).
 *
 * *"Achados relacionais recaem sobre o anúncio de **menor `aiScore`**; empate por
 * menor `id`. Os demais constam em `evidence.relatedAdIds`."*
 *
 * **O determinismo é o mecanismo, não a estética.** O fingerprint é
 * `sha256(adId | type)`: se a atribuição variasse entre execuções, o mesmo
 * problema geraria um item novo a cada ciclo, `occurrences` nunca passaria de 1 e
 * a deduplicação — que existe para o usuário não receber o mesmo alerta todo dia
 * — deixaria de funcionar sem nada quebrar visivelmente.
 */

export const ATTRIBUTION_RULE = 'LOWEST_AI_SCORE_THEN_LOWEST_ID';

export type Attribution = {
  adId: string;
  /** Os outros anúncios envolvidos, em ordem estável. */
  relatedAdIds: string[];
  rule: string;
};

/**
 * Anúncio sem score entra como `+Infinity`, isto é: **nunca é o escolhido**
 * enquanto houver um anúncio pontuado no conjunto.
 *
 * Atribuir a um anúncio sem score seria escolher pela ausência de informação,
 * quando existe informação ao lado. Se nenhum tem score, todos empatam e o menor
 * `id` decide — que continua sendo determinístico, que é o requisito.
 */
export function attribute(
  ads: AdWindowAggregate[],
  scores: Map<string, AdScoreView>,
): Attribution | null {
  if (ads.length === 0) return null;

  const ranked = [...ads].sort((a, b) => {
    const scoreA = scores.get(a.adId)?.aiScore ?? Number.POSITIVE_INFINITY;
    const scoreB = scores.get(b.adId)?.aiScore ?? Number.POSITIVE_INFINITY;
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.adId < b.adId ? -1 : a.adId > b.adId ? 1 : 0;
  });

  const [target, ...rest] = ranked;

  return {
    adId: target.adId,
    relatedAdIds: rest.map((ad) => ad.adId).sort(),
    rule: ATTRIBUTION_RULE,
  };
}
