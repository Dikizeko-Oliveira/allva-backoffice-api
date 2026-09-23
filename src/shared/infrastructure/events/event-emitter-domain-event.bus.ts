import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { DomainEvent } from '@/shared/domain/events/domain-event';
import {
  DomainEventBus,
  EmitContext,
} from '@/shared/domain/events/domain-event-bus';
import {
  DOMAIN_EVENT_VERSIONS,
  DomainEventMap,
  DomainEventName,
} from '@/shared/domain/events/domain-event-map';

/**
 * Adapter do `DomainEventBus` sobre `EventEmitter2` (§5.6.2).
 *
 * **In-process e síncrono, de propósito.** Isso é aceitável porque todo passo
 * dirigido por evento é re-derivável pelo cron — o agendado é rede de segurança
 * permanente, não fallback de emergência. O que **não** é aceitável é um
 * handler pesado rodando inline: sem a regra "handler só enfileira" (⊕10), o
 * `sync` trava atrás do scoring e um lote de ingest passa a ter a latência da
 * cadeia inteira. O harness em `test/architecture/traceability.spec.ts` cobra
 * essa regra.
 *
 * Exceção de handler não sobe para o emissor: `@nestjs/event-emitter` embrulha
 * cada listener num try/catch (`suppressErrors` default `true`). Um consumidor
 * quebrado registra erro e o ingest segue — que é a única leitura compatível
 * com "o cron re-deriva".
 */
@Injectable()
export class EventEmitterDomainEventBus extends DomainEventBus {
  constructor(private readonly emitter: EventEmitter2) {
    super();
  }

  emitFrom<K extends DomainEventName>(
    ctx: EmitContext,
    name: K,
    payload: DomainEventMap[K],
  ): DomainEvent<K> {
    const event: DomainEvent<K> = {
      eventId: randomUUID(),
      name,
      eventVersion: DOMAIN_EVENT_VERSIONS[name],
      occurredAt: new Date().toISOString(),
      organizationId: ctx.organizationId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      payload,
    };

    // O evento inteiro vai como argumento único: o consumidor precisa da
    // envelope (correlação, causalidade, tenant), não só do payload.
    this.emitter.emit(name, event);

    return event;
  }
}
