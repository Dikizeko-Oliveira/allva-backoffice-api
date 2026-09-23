/**
 * Descontinuidade de série (§12.5, achados A12 e ⊕4).
 *
 * Certas mudanças quebram a comparabilidade **sem que nada tenha acontecido com
 * o anúncio**. Delta, tendência e alerta não atravessam uma descontinuidade —
 * sem isso, o dia em que os sinais de feedback negativo entram produz um salto
 * de score em todo anúncio ativo, e o produto reporta em massa quedas e altas
 * que são artefato de release.
 *
 * **O campo é o motivo, não um booleano.** Um `true` diz que a série quebrou e
 * não diz por quê: quem lê não consegue distinguir "trocamos a moeda-base" de
 * "o anúncio ficou uma semana sem entregar", e as duas pedem tratamentos
 * diferentes. `AdScore` já nascia `String?` em A2-S1; `AdMetricSnapshot` nasceu
 * `Boolean` — dois tipos para o mesmo conceito obrigariam cada consumidor a
 * traduzir entre eles, e a tradução é onde a causa se perde.
 *
 * **Por que mora em `ads`.** O motivo aparece no read model da série
 * (`AdSnapshotView`) e em `AdScore`, então `ads` e `ad-scoring` precisam do
 * mesmo vocabulário. `ads` é a base do grafo (§5.3 r.1) e todo mundo já depende
 * dele; declarar aqui evita que `ads` passe a depender de `ad-scoring`, que é a
 * direção proibida.
 */

export type SeriesDiscontinuityReason =
  /** `hides`/`reports` chegando em A2-S4 muda o que `NegativeFeedbackRisk` mede. */
  | 'NEW_SIGNAL'
  /** Reconfiguração da janela de atribuição na plataforma. */
  | 'ATTRIBUTION_WINDOW_CHANGED'
  /** Anúncio retomado depois de um intervalo sem dados. */
  | 'RESUMED_AFTER_PAUSE'
  /** Nova `algoVersion` vigente para a organização. */
  | 'ALGO_VERSION_CHANGED'
  /** Troca de moeda-base (§4.1): a série monetária inteira muda de unidade. */
  | 'CURRENCY_REBASED';

/** As cinco causas, em ordem estável. O harness conta esta lista. */
export const SERIES_DISCONTINUITY_REASONS: readonly SeriesDiscontinuityReason[] =
  [
    'NEW_SIGNAL',
    'ATTRIBUTION_WINDOW_CHANGED',
    'RESUMED_AFTER_PAUSE',
    'ALGO_VERSION_CHANGED',
    'CURRENCY_REBASED',
  ];

/**
 * Lê a coluna como motivo, recusando o que não pertence ao vocabulário.
 *
 * A coluna é `TEXT`, então nada no banco impede uma string qualquer. Devolver
 * `null` para valor desconhecido é a leitura conservadora: uma descontinuidade
 * que ninguém sabe nomear não deve **impedir** a comparação — deve ser
 * investigada, e o log é onde isso aparece. O contrário — tratar desconhecido
 * como descontinuidade — cortaria séries inteiras por causa de um typo.
 */
export function asDiscontinuityReason(
  value: string | null | undefined,
): SeriesDiscontinuityReason | null {
  if (!value) return null;

  return SERIES_DISCONTINUITY_REASONS.includes(
    value as SeriesDiscontinuityReason,
  )
    ? (value as SeriesDiscontinuityReason)
    : null;
}

/** `true` quando a série **não** pode ser lida através deste ponto. */
export function breaksSeries(value: string | null | undefined): boolean {
  return asDiscontinuityReason(value) !== null;
}
