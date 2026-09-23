import { randomUUID } from 'node:crypto';

/**
 * O que atravessa a fronteira da fila (arquitetura §5.6.2, achado ⊕16).
 *
 * `EventEmitter2` é in-process: assim que um handler enfileira um job Bull, a
 * cadeia de causalidade morre — e ela morre exatamente nos saltos que se quer
 * auditar, porque os triviais são os que ficam no mesmo processo. Por isso
 * **todo payload de job Bull carrega um `JobContext`**, e `emitFrom(ctx, …)`
 * usa esse contexto para preencher a envelope do próximo evento.
 *
 * | | Nasce | Muda | Responde |
 * |---|---|---|---|
 * | `correlationId` | na origem (tick do cron, requisição HTTP, gatilho manual) | nunca | "tudo que aconteceu por causa daquele ingest das 14h" |
 * | `causationId` | a cada salto | sempre | "o que exatamente gerou este evento" |
 */
export type JobContext = {
  /** Constante na cadeia inteira, da origem ao último efeito. */
  correlationId: string;
  /** `eventId` do imediatamente anterior; `null` na origem. */
  causationId: string | null;
};

/**
 * Contexto de origem: um tick de cron, um gatilho manual, um worker que não
 * nasceu de evento nenhum. `causationId` é `null` por definição — não há
 * antecessor.
 *
 * Requisições HTTP não usam esta função: o `CorrelationIdMiddleware` honra o
 * `X-Correlation-Id` de entrada e é ele quem estabelece a origem.
 */
export function createRootJobContext(correlationId?: string): JobContext {
  return { correlationId: correlationId ?? randomUUID(), causationId: null };
}

/**
 * O contexto com que um consumidor de `event` deve emitir o que vier a seguir:
 * mesma correlação, causalidade avançando um salto.
 *
 * Um handler que reemitisse com o próprio `ctx` recebido produziria irmãos onde
 * deveria haver filhos — a lista continuaria certa e o grafo, errado.
 */
export function jobContextFrom(event: {
  correlationId: string;
  eventId: string;
}): JobContext {
  return { correlationId: event.correlationId, causationId: event.eventId };
}
