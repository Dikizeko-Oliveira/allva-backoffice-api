import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { DomainEvent } from '@/shared/domain/events/domain-event';
import {
  DomainEventBus,
  emitContext,
} from '@/shared/domain/events/domain-event-bus';
import { DOMAIN_EVENT_NAMES } from '@/shared/domain/events/domain-event-map';
import {
  createRootJobContext,
  jobContextFrom,
} from '@/shared/domain/events/job-context';
import { EventsModule } from './events.module';
import { OnDomainEvent, jobIdFor } from './on-domain-event.decorator';

/**
 * Fila falsa com a única regra de Bull que interessa aqui: um `jobId` que já
 * existe não entra duas vezes. É o que sustenta a convenção de handler
 * idempotente — o handler não decide se já processou, o id do evento decide.
 */
@Injectable()
class FakeQueue {
  readonly jobs: { jobId: string; data: unknown }[] = [];

  add(data: unknown, jobId: string): boolean {
    if (this.jobs.some((job) => job.jobId === jobId)) return false;
    this.jobs.push({ jobId, data });
    return true;
  }
}

/** Consumidor 1: enfileira o rescoring. Não pontua inline (⊕10). */
@Injectable()
class ScoringConsumer {
  constructor(
    private readonly queue: FakeQueue,
    private readonly bus: DomainEventBus,
  ) {}

  @OnDomainEvent('ad.metrics.updated')
  onMetricsUpdated(event: DomainEvent<'ad.metrics.updated'>): void {
    this.queue.add(
      { adId: event.payload.adId, ctx: jobContextFrom(event) },
      jobIdFor(event, 'scoring'),
    );
  }
}

/** Consumidor 2: mesmo evento, outra fila, outro sufixo de id. */
@Injectable()
class WasteConsumer {
  readonly seen: DomainEvent<'ad.metrics.updated'>[] = [];

  constructor(private readonly queue: FakeQueue) {}

  @OnDomainEvent('ad.metrics.updated')
  onMetricsUpdated(event: DomainEvent<'ad.metrics.updated'>): void {
    this.seen.push(event);
    this.queue.add({ adId: event.payload.adId }, jobIdFor(event, 'waste'));
  }
}

/** Consumidor que quebra — o emissor não pode quebrar junto. */
@Injectable()
class FailingConsumer {
  @OnDomainEvent('ad.metrics.updated')
  onMetricsUpdated(_event: DomainEvent<'ad.metrics.updated'>): void {
    throw new Error('consumer exploded');
  }
}

const ORGANIZATION_ID = 'org-1';

const PAYLOAD = {
  adId: 'ad-1',
  dateRange: { from: '2026-07-01', to: '2026-07-30' },
  inputDigest: 'digest-1',
};

describe('DomainEventBus', () => {
  let moduleRef: TestingModule;
  let bus: DomainEventBus;
  let emitter: EventEmitter2;
  let scoringQueue: FakeQueue;
  let waste: WasteConsumer;
  let errorLog: jest.SpyInstance;

  beforeEach(async () => {
    // `FailingConsumer` assina o mesmo evento de todos os casos, então o loader
    // do @nestjs/event-emitter registraria um stack trace esperado a cada
    // emissão. Silenciar aqui mantém o output do CI legível — o caso que cobre
    // o comportamento verifica que a chamada aconteceu.
    errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    moduleRef = await Test.createTestingModule({
      imports: [EventsModule],
      providers: [FakeQueue, ScoringConsumer, WasteConsumer, FailingConsumer],
    }).compile();

    // Os listeners são registrados em `onApplicationBootstrap`; sem `init()` o
    // barramento existe e ninguém está ouvindo.
    await moduleRef.init();

    bus = moduleRef.get(DomainEventBus);
    emitter = moduleRef.get(EventEmitter2);
    scoringQueue = moduleRef.get(FakeQueue);
    waste = moduleRef.get(WasteConsumer);
  });

  afterEach(async () => {
    errorLog.mockRestore();
    await moduleRef.close();
  });

  it('preenche a envelope inteira a partir do contexto de emissão', () => {
    const ctx = emitContext(createRootJobContext('corr-1'), ORGANIZATION_ID);

    const event = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);

    expect(event).toMatchObject({
      name: 'ad.metrics.updated',
      eventVersion: 1,
      organizationId: ORGANIZATION_ID,
      correlationId: 'corr-1',
      causationId: null,
      payload: PAYLOAD,
    });
    expect(event.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);
  });

  it('dá identidade própria a cada emissão — sem isso não há causalidade (⊕15)', () => {
    const ctx = emitContext(createRootJobContext(), ORGANIZATION_ID);

    const first = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);
    const second = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);

    expect(first.eventId).not.toBe(second.eventId);
  });

  it('entrega o mesmo evento aos dois consumidores', () => {
    const ctx = emitContext(createRootJobContext(), ORGANIZATION_ID);

    const event = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);

    expect(waste.seen).toEqual([event]);
    expect(scoringQueue.jobs.map((job) => job.jobId)).toEqual([
      jobIdFor(event, 'scoring'),
      jobIdFor(event, 'waste'),
    ]);
  });

  it('reemitir o mesmo evento não duplica efeito', () => {
    const ctx = emitContext(createRootJobContext(), ORGANIZATION_ID);
    const event = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);

    // Reentrega literal: mesma envelope, mesmo `eventId`. É o que acontece num
    // retry do emissor ou num replay do cron.
    emitter.emit(event.name, event);
    emitter.emit(event.name, event);

    expect(waste.seen).toHaveLength(3);
    // Os handlers rodaram três vezes; o efeito aconteceu uma. A idempotência é
    // do id do evento, não da disciplina de quem escreve o handler.
    expect(scoringQueue.jobs).toHaveLength(2);
  });

  it('mantém a correlação e avança a causalidade a cada salto', () => {
    const ctx = emitContext(createRootJobContext('corr-2'), ORGANIZATION_ID);
    const upstream = bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD);

    const downstream = bus.emitFrom(
      emitContext(jobContextFrom(upstream), ORGANIZATION_ID),
      'ad.scored',
      {
        adId: 'ad-1',
        adScoreId: 'score-1',
        aiScore: 72,
        delta7d: null,
        algoVersion: 'deterministic-v2',
      },
    );

    expect(downstream.correlationId).toBe('corr-2');
    expect(downstream.causationId).toBe(upstream.eventId);
  });

  it('não deixa a exceção de um consumidor derrubar o emissor', () => {
    const ctx = emitContext(createRootJobContext(), ORGANIZATION_ID);

    expect(() =>
      bus.emitFrom(ctx, 'ad.metrics.updated', PAYLOAD),
    ).not.toThrow();
    // E os demais consumidores continuam recebendo.
    expect(waste.seen).toHaveLength(1);
    // A falha não some: o loader a registra, e é assim que o consumidor
    // quebrado aparece sem levar o emissor junto.
    expect(errorLog).toHaveBeenCalledWith(
      'consumer exploded',
      expect.any(String),
    );
  });

  it('declara os 22 eventos de §5.6 mais os derivados registrados', () => {
    // Os dois extras nasceram da **mesma** impossibilidade: um tipo de alerta
    // declarado no schema, §5.3 r.7 proibindo injeção direta em `alerts`, e
    // nenhum evento na tabela de §5.6 que carregasse a condição.
    //
    // - `sync.archive_suppressed` (A2-S3) → `AD_ARCHIVE_SUPPRESSED`;
    // - `denormalization.drift_detected` (A2-S5) → `DENORMALIZATION_DRIFT`.
    //
    // O número é asserção de verdade: um evento novo sem justificativa
    // registrada no `DomainEventMap` quebra aqui.
    //
    // 25 desde `ad_account.first_sync_completed`, que existe porque os módulos
    // da cadeia de inteligência já importam `SyncModule` e uma chamada na
    // direção oposta fecharia ciclo — a justificativa está no `DomainEventMap`.
    //
    // 26 desde `organization.deleted`, pela mesma natureza de ciclo:
    // `integrations` importa `OrganizationsModule`, e revogar as credenciais de
    // uma organização excluída não podia ser chamado de dentro de `organizations`.
    expect(DOMAIN_EVENT_NAMES).toHaveLength(26);
  });
});
