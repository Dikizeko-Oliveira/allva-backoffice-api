import { DomainEventMap, DomainEventName } from './domain-event-map';

/**
 * A envelope de §5.6.1. Todo evento de domínio da v2.0 sai daqui.
 *
 * `causationId` **exige** `eventId` (achado ⊕15): sem identidade própria de
 * evento, causalidade não é representável — só se consegue dizer de qual ciclo
 * algo veio, nunca o que exatamente o disparou.
 */
export type DomainEvent<K extends DomainEventName = DomainEventName> = {
  /** Identidade própria — é o alvo do `causationId` do próximo. */
  eventId: string;
  /** Estável para sempre; a versão NÃO entra no nome. */
  name: K;
  eventVersion: number;
  /** ISO-8601. Payload de evento é serializável — `Date` não atravessa a fila. */
  occurredAt: string;
  organizationId: string;
  /** Constante na cadeia inteira. */
  correlationId: string;
  /** `eventId` do imediatamente anterior; `null` na origem. */
  causationId: string | null;
  payload: DomainEventMap[K];
};

/** Uma união discriminada por `name` — o que um handler genérico recebe. */
export type AnyDomainEvent = {
  [K in DomainEventName]: DomainEvent<K>;
}[DomainEventName];
