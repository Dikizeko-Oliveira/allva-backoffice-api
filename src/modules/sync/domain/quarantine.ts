/**
 * Quarentena de sync (§8.2 passo 5, achado C6, ⊕8).
 *
 * Um anúncio cuja campanha ou conjunto não pôde ser resolvido **não aborta o
 * ingest e não é descartado**: vai para `sync_quarantine`. Descartar em silêncio
 * é como o produto perde anúncios que existem e gastam.
 *
 * O que faltava na primeira redação era o **caminho de volta**: `GET
 * /sync/quarantine` mostrava, e nada tirava de lá. Um ad em quarentena por
 * campanha ainda não sincronizada nunca entraria no domínio, mesmo depois de a
 * campanha aparecer — a quarentena virava cemitério.
 */

export type QuarantineReason =
  | 'CAMPAIGN_NOT_RESOLVED'
  | 'AD_SET_NOT_RESOLVED'
  | 'MISSING_PARENT_REFERENCE';

export type QuarantineResolution =
  | 'PARENT_APPEARED'
  | 'ABANDONED'
  | 'AD_DISAPPEARED';

/**
 * Depois de quantas tentativas um item parado deixa de ser esperança e vira
 * dívida.
 *
 * O abandono é registrado, nunca silencioso: `ABANDONED` com `resolvedAt` diz
 * "desistimos deste, e em que dia" — o que permite alguém investigar. Apagar a
 * linha diria que ela nunca existiu.
 */
export const QUARANTINE_MAX_ATTEMPTS = 30;

export type QuarantineItem = {
  externalAdId: string;
  attempts: number;
  reason: QuarantineReason;
};

export type QuarantineVerdict =
  /** O pai apareceu: o ad entra no domínio nesta mesma passagem. */
  | { kind: 'RESOLVE'; resolution: 'PARENT_APPEARED' }
  /** O ad sumiu da plataforma antes de o pai chegar. */
  | { kind: 'RESOLVE'; resolution: 'AD_DISAPPEARED' }
  /** Tentativas esgotadas — fica registrado como desistência declarada. */
  | { kind: 'RESOLVE'; resolution: 'ABANDONED' }
  /** Continua esperando; `attempts` incrementa. */
  | { kind: 'RETAIN' };

/**
 * O que fazer com um item em quarentena no ingest seguinte.
 *
 * A ordem das perguntas importa: um ad cujo pai apareceu **e** que já esgotou
 * tentativas deve entrar no domínio, não ser abandonado. Abandonar o que agora
 * é resolvível seria perder o anúncio no exato momento em que deixou de haver
 * motivo para perdê-lo.
 */
export function evaluateQuarantineItem(input: {
  item: QuarantineItem;
  /** O ad ainda apareceu na leitura desta rodada. */
  stillPresent: boolean;
  /** Campanha (e conjunto, quando exigido) resolvíveis agora. */
  parentResolvable: boolean;
}): QuarantineVerdict {
  if (input.parentResolvable && input.stillPresent) {
    return { kind: 'RESOLVE', resolution: 'PARENT_APPEARED' };
  }

  if (!input.stillPresent) {
    return { kind: 'RESOLVE', resolution: 'AD_DISAPPEARED' };
  }

  if (input.item.attempts >= QUARANTINE_MAX_ATTEMPTS) {
    return { kind: 'RESOLVE', resolution: 'ABANDONED' };
  }

  return { kind: 'RETAIN' };
}
