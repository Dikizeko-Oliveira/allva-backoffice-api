import { WasteAlertListener } from './waste-alert.listener';
import type { RaiseAlertJobData } from '../queues/alerts.dispatcher';
import type { DomainEvent } from 'src/shared/domain/events/domain-event';
import type {
  DomainEventName,
  WastePriorityLevel,
} from 'src/shared/domain/events/domain-event-map';

/**
 * O lado do desperdício de `alerts` como consumidor de evento puro (§5.3 r.7).
 *
 * O `WASTE_ITEM` é **o sujeito que o v1 não conseguia preencher**: o worker
 * antigo passava `referenceType: 'waste_item'` sem `referenceId`, e o alerta
 * nascia apontando para lugar nenhum. Aqui o sujeito é escolhido no listener,
 * contra o conjunto fechado de seis FKs, e estes testes cobram os dois lados —
 * que ele saia certo, e que **não saia** quando não deveria.
 */

function eventOf<K extends DomainEventName>(
  name: K,
  payload: DomainEvent<K>['payload'],
): DomainEvent<K> {
  return {
    eventId: 'evt-1',
    name,
    eventVersion: 1,
    occurredAt: '2026-08-02T06:00:00.000Z',
    organizationId: 'org-1',
    correlationId: 'corr-1',
    causationId: null,
    payload,
  };
}

function detected(
  overrides: Partial<DomainEvent<'waste.detected'>['payload']> = {},
) {
  return eventOf('waste.detected', {
    adId: 'ad-1',
    wasteItemId: 'item-1',
    type: 'ZERO_CONVERSIONS',
    kind: 'WASTE' as const,
    incurred: {
      value: 1_400,
      currency: 'BRL',
      valueBase: 1_400,
      baseCurrency: 'BRL',
    },
    avoidableDaily: {
      value: 100,
      currency: 'BRL',
      valueBase: 100,
      baseCurrency: 'BRL',
    },
    priority: 'CRITICAL' as WastePriorityLevel,
    ...overrides,
  });
}

function buildListener() {
  const raised: Array<{ data: RaiseAlertJobData; jobId?: string }> = [];
  const dispatcher = {
    raise: async (data: RaiseAlertJobData, jobId?: string) => {
      raised.push({ data, jobId });
    },
  };

  return { listener: new WasteAlertListener(dispatcher as never), raised };
}

describe('alerta de desperdício', () => {
  it('o sujeito é o WASTE_ITEM, com id — o órfão do v1 é impossível aqui', async () => {
    const h = buildListener();

    await h.listener.onDetected(detected());

    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].data.subject).toEqual({
      kind: 'WASTE_ITEM',
      wasteItemId: 'item-1',
    });
    expect(h.raised[0].data.type).toBe('WASTE_DETECTED');
    expect(h.raised[0].data.organizationId).toBe('org-1');
  });

  it('a mensagem carrega o EVITÁVEL, não o incorrido', async () => {
    // §10.1: o incorrido já foi. Alertar por dano acumulado convida a uma ação
    // que não recupera nada; o evitável é o número sobre o qual ainda há o que
    // fazer, e é o único comparável com o impacto medido depois.
    const h = buildListener();

    await h.listener.onDetected(detected());

    expect(h.raised[0].data.message).toContain('100,00');
    expect(h.raised[0].data.message).toContain('por dia');
    expect(h.raised[0].data.message).not.toContain('1400');
    // O incorrido não some: vai para os metadados, onde é contexto e não manchete.
    expect(h.raised[0].data.metadata).toMatchObject({ incurredBase: 1_400 });
  });

  it('o achado entra pelo rótulo — o enum nunca chega ao usuário', async () => {
    // `OVERLAPPING_DELIVERY` é chave de fingerprint e de filtro. Interpolado na
    // mensagem, obrigava o usuário a deduzir o problema a partir de uma
    // constante de código — e a mesma `message` vai para o e-mail.
    const h = buildListener();

    await h.listener.onDetected(detected({ type: 'OVERLAPPING_DELIVERY' }));

    expect(h.raised[0].data.message).toContain('Entrega sobreposta');
    expect(h.raised[0].data.message).not.toContain('OVERLAPPING_DELIVERY');
  });

  it('um tipo sem rótulo cai no código cru, e não em "Desconhecido"', async () => {
    // O esquecimento de quem adiciona um detector precisa aparecer, não ser
    // absorvido por um rótulo genérico que esconde qual achado é qual.
    const h = buildListener();

    await h.listener.onDetected(detected({ type: 'DETECTOR_NOVO' }));

    expect(h.raised[0].data.message).toContain('DETECTOR_NOVO');
  });

  it('CRITICAL vira alerta CRITICAL; HIGH vira WARNING', async () => {
    const critical = buildListener();
    await critical.listener.onDetected(detected({ priority: 'CRITICAL' }));
    expect(critical.raised[0].data.severity).toBe('CRITICAL');

    const high = buildListener();
    await high.listener.onDetected(detected({ priority: 'HIGH' }));
    expect(high.raised[0].data.severity).toBe('WARNING');
  });

  it('MEDIUM e LOW não alertam — continuam na lista, que é onde se olha', async () => {
    // Um ciclo diário sobre uma conta grande produz dezenas de achados `LOW`.
    // Alertar sobre todos ensina o usuário a ignorar a caixa antes do primeiro
    // caso que importa.
    for (const priority of ['MEDIUM', 'LOW'] as WastePriorityLevel[]) {
      const h = buildListener();
      await h.listener.onDetected(detected({ priority }));
      expect(h.raised).toEqual([]);
    }
  });

  it('oportunidade nunca alerta, nem com prioridade alta', async () => {
    // Oportunidade é dinheiro que **poderia** ser ganho. Interromper o dia de
    // alguém por isso inverte a relação entre as duas grandezas de §10.1.
    const h = buildListener();

    await h.listener.onDetected(
      detected({ kind: 'OPPORTUNITY', priority: 'CRITICAL' }),
    );

    expect(h.raised).toEqual([]);
  });

  it('o jobId deriva do evento — reentrega colapsa no mesmo job', async () => {
    const h = buildListener();

    await h.listener.onDetected(detected());

    expect(h.raised[0].jobId).toBe('waste.detected:evt-1:waste-detected');
  });
});

describe('alerta de drift de denormalização (C3)', () => {
  it('o sujeito é o ANÚNCIO cuja coluna divergiu', async () => {
    const h = buildListener();

    await h.listener.onDrift(
      eventOf('denormalization.drift_detected', {
        adId: 'ad-1',
        adAccountId: 'acc-1',
        field: 'open_waste_amount_base',
        stored: 99,
        actual: 1_400,
      }),
    );

    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].data.subject).toEqual({ kind: 'AD', adId: 'ad-1' });
    expect(h.raised[0].data.type).toBe('DENORMALIZATION_DRIFT');
  });

  it('a mensagem diz os dois números e que a agregação venceu', async () => {
    // §10.8: a agregação é a verdade e a coluna **já foi corrigida** quando o
    // evento sai. Sem o par de números, "houve divergência" não permite a
    // ninguém julgar se ela importava.
    const h = buildListener();

    await h.listener.onDrift(
      eventOf('denormalization.drift_detected', {
        adId: 'ad-1',
        adAccountId: 'acc-1',
        field: 'open_waste_amount_base',
        stored: 99,
        actual: 1_400,
      }),
    );

    expect(h.raised[0].data.message).toContain('99');
    expect(h.raised[0].data.message).toContain('1400');
    expect(h.raised[0].data.message).toContain('corrigida');
  });
});
