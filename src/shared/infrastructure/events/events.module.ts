import { Global, Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DomainEventBus } from '@/shared/domain/events/domain-event-bus';
import { EventEmitterDomainEventBus } from './event-emitter-domain-event.bus';

/**
 * O barramento de eventos da v2.0 (arquitetura §5.6, A2-S0).
 *
 * Global porque §5.6 define 22 eventos como espinha dorsal do sistema: exigir
 * `imports: [EventsModule]` em cada módulo faria o emissor depender do
 * barramento por acidente de wiring, e a primeira omissão viraria um evento que
 * ninguém emite — silenciosamente.
 *
 * `wildcard: true` com delimitador `.` é o que permite um consumidor
 * transversal assinar `ad.*` ou `waste.*` sem enumerar nomes. `audit` e
 * `alerts` são precisamente isso: consumidores de evento puros (§5.3 r.7), e é
 * essa regra que corrige o alerta órfão da v1.
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: true,
      delimiter: '.',
      // Um vazamento de listener aqui é um consumidor registrado em loop; o
      // aviso verboso nomeia o evento em vez de dizer só "possible memory leak".
      verboseMemoryLeak: true,
    }),
  ],
  providers: [
    { provide: DomainEventBus, useClass: EventEmitterDomainEventBus },
  ],
  exports: [DomainEventBus],
})
export class EventsModule {}
