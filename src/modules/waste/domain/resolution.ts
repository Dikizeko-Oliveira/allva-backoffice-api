import type { WasteResolutionKind } from './contracts/finding-catalog';

/**
 * Auto-resolve (§10.7 passo 7) — e a regra que o sustenta:
 *
 * > **Ausência de dado nunca é evidência.**
 *
 * Os passos 1 e 7 são a mesma ideia aplicada duas vezes. Sem eles, uma
 * integração fora do ar por uma noite resolveria todo o desperdício aberto da
 * organização como "condição cessou" — e na manhã seguinte o produto reportaria
 * um dia excepcionalmente bom, produzido inteiramente pela própria cegueira.
 */

export type ObservationState = {
  /**
   * A conta teve sync bem-sucedido e **completo** cobrindo esta janela?
   *
   * `false` congela o anúncio: os itens abertos ficam abertos, marcados com
   * `staleObservation`, e nenhum deles é resolvido por nada.
   */
  valid: boolean;
  /** Arquivado **com sync completo** — arquivado por leitura parcial não conta. */
  adArchived: boolean;
};

export type ResolutionDecision =
  | { action: 'KEEP'; staleObservation: boolean }
  | { action: 'RESOLVE'; kind: WasteResolutionKind; reason: string };

/**
 * O que fazer com um item aberto que **não** foi redetectado neste ciclo.
 *
 * Redetectado não passa por aqui: ele é atualizado pelo upsert do passo 6, e um
 * item que continua sendo detectado nunca está sendo resolvido.
 */
export function decideResolution(input: {
  observation: ObservationState;
  /** Ver `isRestatement` — o dado do passado mudou e desfez o achado. */
  restated: boolean;
}): ResolutionDecision {
  if (!input.observation.valid) {
    return { action: 'KEEP', staleObservation: true };
  }

  if (input.observation.adArchived) {
    return {
      action: 'RESOLVE',
      kind: 'STALE',
      reason: 'O anúncio foi arquivado na plataforma.',
    };
  }

  // Ordem importa: um item que sumiu **porque o dado foi reescrito** é falso
  // positivo, não acerto. Classificá-lo como `RESOLVED_EXTERNALLY` inflaria a
  // taxa de acerto do detector com os casos em que ele errou — e é essa taxa que
  // P8 usa para decidir se a versão nova do detector é melhor que a atual.
  if (input.restated) {
    return {
      action: 'RESOLVE',
      kind: 'RESOLVED_BY_RESTATEMENT',
      reason:
        'A plataforma re-declarou as métricas da janela e o achado deixou de existir.',
    };
  }

  return {
    action: 'RESOLVE',
    kind: 'RESOLVED_EXTERNALLY',
    reason: 'A condição que originou o achado cessou.',
  };
}

/**
 * Tolerância de gasto que separa "o anúncio continuou entregando" de "os números
 * do passado mudaram".
 *
 * Não é zero porque a re-declaração também mexe em gasto (tráfego inválido
 * estornado, ajuste de leilão): exigir gasto idêntico classificaria como mudança
 * real toda re-declaração que veio acompanhada de um centavo de correção.
 */
const SPEND_TOLERANCE_RATIO = 0.02;

/**
 * O achado sumiu **porque o passado foi reescrito**?
 *
 * O discriminador é a combinação, não cada metade: gasto praticamente parado com
 * conversão ou receita subindo só acontece quando a plataforma atribui
 * retroativamente. Gasto subindo com conversão subindo é o anúncio continuando a
 * rodar e passando a converter — isso é `RESOLVED_EXTERNALLY` de verdade, e o
 * detector acertou.
 *
 * Sem os valores anteriores (item de antes de a evidência carregar `observed`),
 * devolve `false`: na dúvida, o desfecho conservador é creditar o acerto ao
 * mundo, não à re-declaração — o inverso inflaria a contagem de falsos positivos
 * com casos que ninguém verificou.
 */
export function isRestatement(input: {
  previousObserved: Record<string, number> | null;
  currentObserved: Record<string, number>;
}): boolean {
  const previous = input.previousObserved;
  if (!previous) return false;

  const previousSpend = previous.spendBase;
  const currentSpend = input.currentObserved.spendBase;
  if (previousSpend === undefined || currentSpend === undefined) return false;

  if (currentSpend > previousSpend * (1 + SPEND_TOLERANCE_RATIO)) return false;

  const conversionsGrew =
    (input.currentObserved.conversions ?? 0) > (previous.conversions ?? 0);
  const revenueGrew =
    (input.currentObserved.revenueBase ?? 0) > (previous.revenueBase ?? 0);

  return conversionsGrew || revenueGrew;
}

/**
 * §10.4 — **só mudança de lógica supersede.**
 *
 * Trocar um limiar não dispara `SUPERSEDED_BY_DETECTOR`: o achado é o mesmo, o
 * corte é que mudou. Se a troca de perfil supersedesse, calibrar um limiar
 * fecharia e reabriria toda a base — `occurrences` voltaria a 1 em cada item, e
 * a recorrência, que é sinal de P8, seria zerada por um ajuste de configuração.
 */
export function supersededByDetector(input: {
  itemDetectorVersion: string;
  currentDetectorVersion: string;
}): boolean {
  return input.itemDetectorVersion !== input.currentDetectorVersion;
}
