import type { JobContext } from '../../src/shared/domain/events/job-context';

/**
 * **A fila, em processo** — o harness que três sprints esperaram.
 *
 * Os gates E2E de A2-S7, A2-S8 e A2-S9 dependiam todos da mesma peça ausente:
 * um jeito de exercitar `use case → fila → worker → desfecho` sem Redis. Cada
 * sprint declarou que ela "não é pré-requisito do próximo" — cada um estava
 * certo, e a soma virou uma decisão que ninguém tomou.
 *
 * ## O que este harness prova, e o que não prova
 *
 * **Prova a cadeia.** Que o `apply` enfileira, que o worker liquida, que a
 * liquidação marca `APPLIED`, que a transação grava o outcome, que o job de
 * medição o fecha. É a cadeia que continha o defeito de A2-S9: `capturePreWindow`
 * sem chamador, invisível para `tsc` e para toda suíte de unidade.
 *
 * **Não prova o Bull.** Colapso por `jobId`, backoff exponencial, política de
 * retry e `removeOnComplete` são configuração do broker, e verificá-los exige
 * Redis de verdade. São coisas diferentes, e confundi-las produziria um harness
 * lento que testa mal as duas.
 *
 * ## Por que síncrono, e não um Bull em memória
 *
 * Porque o que se quer verificar é **ordem causal**, não concorrência: o efeito
 * do passo N tem de estar visível no passo N+1. Um Bull em memória
 * reintroduziria o assincronismo — e com ele o `await new Promise(r =>
 * setTimeout(r, 500))` que torna um teste de integração lento e intermitente ao
 * mesmo tempo.
 */

/** Um job despachado: o nome, o payload, e a ordem em que entrou. */
export type DispatchedJob = { name: string; data: unknown };

/**
 * Teto de re-despachos encadeados.
 *
 * Execução síncrona transforma "reenfileirar" em **recursão**: um job que se
 * redespacha vira pilha, não fila. Sem teto, um retry mal guardado pendura a
 * suíte em vez de falhar — e um teste que pendura é pior que um que quebra,
 * porque não diz nada.
 */
const MAX_DISPATCH_DEPTH = 20;

/**
 * Executa o handler na hora e registra o despacho.
 *
 * O **registro** é metade do valor: um teste que só verifica o efeito final não
 * distingue "o worker rodou uma vez" de "rodou três", e a idempotência que §9.5
 * exige é exatamente sobre isso.
 */
export class InlineQueue {
  readonly dispatched: DispatchedJob[] = [];

  private depth = 0;

  /**
   * `delayMs` é **registrado e ignorado**.
   *
   * A escada de verificação de §13.4 agenda o primeiro degrau em T+90s, e
   * esperar 90 segundos num teste não verifica nada além do relógio. O que
   * importa é que o degrau foi agendado, e com que atraso — o teste afirma
   * sobre o número, não sobre a espera.
   */
  private readonly handlers = new Map<
    string,
    (data: never) => Promise<unknown>
  >();

  on<T>(name: string, handler: (data: T) => Promise<unknown>): this {
    this.handlers.set(name, handler as (data: never) => Promise<unknown>);
    return this;
  }

  async dispatch(name: string, data: unknown): Promise<void> {
    this.dispatched.push({ name, data });

    if (this.depth >= MAX_DISPATCH_DEPTH) {
      throw new Error(
        `[inline-queue] "${name}" excedeu ${MAX_DISPATCH_DEPTH} redespachos encadeados — laço de reenfileiramento`,
      );
    }

    const handler = this.handlers.get(name);

    /**
     * Job sem handler registrado é **erro**, não silêncio.
     *
     * Um harness que engole o despacho desconhecido deixa passar exatamente o
     * defeito que ele existe para pegar: a cadeia que se interrompe porque
     * ninguém escuta o próximo passo.
     */
    if (!handler) {
      throw new Error(
        `[inline-queue] job "${name}" despachado sem handler registrado — a cadeia se interrompe aqui`,
      );
    }

    this.depth += 1;
    try {
      await handler(data as never);
    } finally {
      this.depth -= 1;
    }
  }

  /** Quantas vezes um job foi despachado. A idempotência se mede aqui. */
  countOf(name: string): number {
    return this.dispatched.filter((job) => job.name === name).length;
  }

  payloadsOf<T>(name: string): T[] {
    return this.dispatched
      .filter((job) => job.name === name)
      .map((job) => job.data as T);
  }

  reset(): void {
    this.dispatched.length = 0;
    this.depth = 0;
  }
}

/** O contexto de job que os despachos do harness carregam (§5.6.2). */
export function testJobContext(): JobContext {
  return { correlationId: 'e2e-correlation', causationId: null };
}
