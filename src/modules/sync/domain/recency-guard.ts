/**
 * A guarda de recência (§8.4.1) e o seu fallback obrigatório (achado B4).
 *
 * ```text
 * se observedAsOf > desiredStatusSetAt  → grava status e métricas
 * senão                                 → grava métricas, IGNORA o status
 * ```
 *
 * `observedAsOf` é o instante **do dado na plataforma**, não o da gravação
 * local. Um ingest iniciado antes de uma ação e concluído depois gravaria um
 * status obsoleto, e a reconciliação declararia `DRIFTED` num anúncio que
 * obedeceu — o produto alertando sobre uma divergência que ele mesmo criou. Em
 * contas grandes a janela entre buscar e gravar é de minutos: o cenário é o caso
 * comum, não a exceção.
 *
 * **Métricas nunca são ignoradas.** Elas descrevem o passado, que a ação não
 * muda; só o status é sobre "agora".
 */

export type ObservedAsOfSource = 'PLATFORM' | 'SYNC_START';

export type ObservedAsOf = {
  observedAsOf: Date;
  source: ObservedAsOfSource;
};

/**
 * Resolve `observedAsOf` sempre — nunca nulo.
 *
 * `PlatformProfile.sync.exposesDataTimestamp` admite plataformas que não expõem
 * o instante do dado (Google e TikTok, hoje). Com `observedAsOf` nulo a guarda
 * seria **indefinida**, e ela é justamente a proteção contra o alerta que o
 * próprio produto fabrica.
 *
 * `SyncOperation.startedAt` é o limite inferior seguro: o dado não pode ser mais
 * novo que o instante em que a leitura começou. A guarda fica bem definida em
 * toda plataforma e o erro cai do lado certo — na dúvida, **não** sobrescreve o
 * status.
 */
export function resolveObservedAsOf(input: {
  /** O que a plataforma expôs, quando expõe. */
  platformTimestamp?: Date | null;
  /** `SyncOperation.startedAt` — o limite inferior. */
  syncStartedAt: Date;
  /** `PlatformProfile.sync.exposesDataTimestamp`. */
  exposesDataTimestamp: boolean;
}): ObservedAsOf {
  if (input.exposesDataTimestamp && input.platformTimestamp) {
    return { observedAsOf: input.platformTimestamp, source: 'PLATFORM' };
  }

  return { observedAsOf: input.syncStartedAt, source: 'SYNC_START' };
}

export type RecencyVerdict = {
  /** `false` ⇒ grava métricas e preserva o status atual. */
  writeStatus: boolean;
  /** Por que não gravou. Vai para `driftDetails` e para o log. */
  reason?: string;
  /** Registrado quando o instante foi substituído pelo limite inferior (B4). */
  observedAsOfSource: ObservedAsOfSource;
};

/**
 * Decide se a observação pode sobrescrever o status local.
 *
 * Sem `desiredStatusSetAt` não há intenção nossa em voo: a observação é a única
 * fonte e escreve sempre. Com intenção em voo, só escreve o que for
 * **estritamente mais novo** que ela — empate perde, porque um dado do mesmo
 * instante da escrita não pode tê-la incorporado.
 */
export function evaluateRecency(input: {
  observed: ObservedAsOf;
  desiredStatusSetAt: Date | null;
}): RecencyVerdict {
  const { observedAsOf, source } = input.observed;

  if (!input.desiredStatusSetAt) {
    return { writeStatus: true, observedAsOfSource: source };
  }

  if (observedAsOf > input.desiredStatusSetAt) {
    return { writeStatus: true, observedAsOfSource: source };
  }

  return {
    writeStatus: false,
    observedAsOfSource: source,
    reason:
      `observação de ${observedAsOf.toISOString()} (${source}) não é mais nova que a ` +
      `intenção registrada em ${input.desiredStatusSetAt.toISOString()}`,
  };
}
