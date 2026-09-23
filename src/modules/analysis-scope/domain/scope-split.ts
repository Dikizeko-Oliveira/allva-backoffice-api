/**
 * A divisão do teto do plano entre **núcleo** e **rodízio**.
 *
 * ## O problema que ela resolve
 *
 * A régua escolhia os N que mais gastaram, toda noite. Como o ranking de gasto é
 * estável, os mesmos anúncios eram olhados para sempre: um cliente com 5.000
 * anúncios no plano de 300 tinha 4.700 que a Allva nunca analisou. E o modo de
 * falha é o pior possível — um anúncio da cauda que começa a desperdiçar só
 * entra em cena quando sobe no ranking, e ele só sobe **gastando mais**.
 *
 * ## Por que dividir, e não simplesmente rodar tudo
 *
 * O teto é o que o cliente contratou, e ele continua valendo: são N por noite,
 * nem mais nem menos. O que muda é que N deixa de ser sempre o mesmo conjunto.
 *
 * ## Por que 80/20, e não 50/50 nem 95/5
 *
 * O núcleo precisa ser **estável**. Os achados são deduplicados por impressão
 * digital e reconfirmados a cada noite; um anúncio que entra e sai faz o achado
 * dele parar de ser reverificado, e `lastSeenAt` envelhece. Metade do teto
 * girando toda noite deixaria metade dos achados sempre defasados.
 *
 * Do outro lado, 5% de rodízio num plano pequeno arredonda para nada — 300 × 5%
 * são 15 vagas, e uma cauda de 4.700 levaria 313 noites. Um quinto é o ponto em
 * que a cauda circula em tempo defensável sem que o núcleo deixe de ser núcleo.
 */
export const ROTATION_SHARE = 0.2;

/**
 * A janela de gasto que ordena a seleção da noite, em dias.
 *
 * Mora no domínio porque quem **descreve** o rodízio precisa da mesma janela de
 * quem o **executa**: a fila que a tela mostra tem de ser contada sobre os
 * mesmos anúncios que a régua considerou. Duas janelas dariam um ciclo que não
 * é o ciclo.
 */
export const RANKING_WINDOW_DAYS = 14;

/** A janela de ranqueamento como par de datas, a partir de agora. */
export function rankingWindow(now: Date): { since: Date; until: Date } {
  const since = new Date(now);
  since.setUTCDate(since.getUTCDate() - RANKING_WINDOW_DAYS + 1);

  return { since, until: new Date(now) };
}

/**
 * Quanto o incumbente pode cair no ranking sem perder a vaga no núcleo.
 *
 * **É a histerese, e ela existe para o corte não oscilar.** Sem margem, dois
 * anúncios com gasto praticamente igual na fronteira trocam de lugar noite após
 * noite conforme centavos entram — e isso é exatamente o "corte arbitrário muda
 * de noite para noite sem que nada tenha mudado na mídia" que o desenho original
 * recusou. 15% é folga suficiente para absorver ruído de gasto diário sem
 * segurar um anúncio que de fato despencou.
 */
export const CORE_HYSTERESIS = 1.15;

export type ScopeSplit = {
  /** Os que mais gastam, analisados toda noite. */
  core: number;
  /** Vagas para a cauda, ordenadas por negligência. */
  rotation: number;
  /** Até que posição um incumbente mantém a vaga no núcleo. */
  coreHighWater: number;
};

/**
 * Divide o teto — e **abaixo de um piso não divide nada**.
 *
 * Com teto muito pequeno, tirar vagas do núcleo para o rodízio troca cobertura
 * por instabilidade sem ganhar nada: um rodízio de uma vaga leva a cauda inteira
 * uma noite por anúncio, e o núcleo perde o anúncio que de fato queima dinheiro.
 * Abaixo de {@link MIN_LIMIT_FOR_ROTATION} o comportamento antigo é o certo.
 *
 * `null` é **sem teto**: nada a dividir, todo anúncio entra toda noite.
 */
export const MIN_LIMIT_FOR_ROTATION = 20;

export function splitScope(limit: number | null): ScopeSplit | null {
  if (limit === null) return null;
  if (limit <= 0) return { core: 0, rotation: 0, coreHighWater: 0 };

  if (limit < MIN_LIMIT_FOR_ROTATION) {
    return { core: limit, rotation: 0, coreHighWater: limit };
  }

  // Arredonda o rodízio para baixo: o núcleo fica com a sobra, e é o lado certo
  // para o resto cair — vaga a mais no núcleo é análise garantida, vaga a mais
  // no rodízio é uma volta a menos na cauda.
  const rotation = Math.floor(limit * ROTATION_SHARE);
  const core = limit - rotation;

  return {
    core,
    rotation,
    coreHighWater: Math.floor(core * CORE_HYSTERESIS),
  };
}

/**
 * Em quantas noites a cauda inteira passa pela análise.
 *
 * Existe para o produto poder **dizer o número** em vez de prometer "todos são
 * analisados" e deixar o cliente descobrir a cadência sozinho. É a diferença
 * entre uma promessa verificável e uma frase de marketing — e é o argumento de
 * upgrade mais honesto que o packaging tem: 5.000 anúncios giram em 80 noites no
 * Individual e em 9 no Profissional.
 *
 * `null` quando não há rodízio (sem teto, ou teto abaixo do piso) ou quando a
 * cauda está vazia: nos dois casos não há ciclo a descrever.
 */
export function rotationCycleNights(
  split: ScopeSplit | null,
  tailSize: number,
): number | null {
  if (!split || split.rotation <= 0 || tailSize <= 0) return null;

  return Math.ceil(tailSize / split.rotation);
}
