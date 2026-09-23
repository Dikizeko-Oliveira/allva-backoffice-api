import { OnEvent } from '@nestjs/event-emitter';
import { OnEventOptions } from '@nestjs/event-emitter/dist/interfaces';
import { DomainEvent } from '@/shared/domain/events/domain-event';
import { DomainEventName } from '@/shared/domain/events/domain-event-map';

/**
 * Assina um evento de domínio com o payload tipado pelo nome.
 *
 * `@OnEvent('ad.scored')` aceitaria `(payload: any)` e um consumidor que lesse
 * `event.adId` em vez de `event.payload.adId` só descobriria em produção. Aqui
 * o `TypedPropertyDescriptor` obriga a assinatura a ser
 * `(event: DomainEvent<'ad.scored'>)` — errar o nome ou o formato é erro de
 * `tsc`.
 *
 * **A regra que acompanha o decorator:** um handler que faz I/O pesado apenas
 * **enfileira** um job Bull (⊕10). Repassando `jobIdFor(event)` como `jobId`, a
 * reentrega do mesmo evento colapsa no mesmo job e o efeito não duplica.
 */
export function OnDomainEvent<K extends DomainEventName>(
  name: K,
  options?: OnEventOptions,
) {
  return (
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<
      (event: DomainEvent<K>) => void | Promise<void>
    >,
  ): void => {
    OnEvent(name, options)(target, propertyKey, descriptor);
  };
}

/**
 * Id de job derivado do evento — a forma barata de idempotência na fronteira da
 * fila.
 *
 * Bull recusa um job cujo `jobId` já existe, então o mesmo evento entregue duas
 * vezes (retry do emissor, replay do cron, reinício com o listener já
 * registrado) produz **um** job. `suffix` separa consumidores distintos do
 * mesmo evento: dois handlers que enfileiram para filas diferentes não podem
 * disputar o mesmo id.
 *
 * Isso é a primeira linha de defesa, não a única: Bull esquece ids evictados por
 * `removeOnComplete`, e o job em si continua tendo de ser idempotente — é o que
 * torna o cron uma rede de segurança de verdade, e não uma segunda execução.
 */
export function jobIdFor(
  event: Pick<DomainEvent, 'eventId' | 'name'>,
  suffix?: string,
): string {
  return suffix
    ? `${event.name}:${event.eventId}:${suffix}`
    : `${event.name}:${event.eventId}`;
}
