import { ActionAlertListener } from './action-alert.listener';
import type { RaiseAlertJobData } from '../queues/alerts.dispatcher';
import type { DomainEvent } from 'src/shared/domain/events/domain-event';

type ExecutedPayload = DomainEvent<'action.executed'>['payload'];

function executed(
  payload: Partial<ExecutedPayload>,
): DomainEvent<'action.executed'> {
  return {
    eventId: 'evt-1',
    name: 'action.executed',
    eventVersion: 1,
    occurredAt: '2026-09-15T14:00:00.000Z',
    organizationId: 'org-1',
    correlationId: 'corr-1',
    causationId: null,
    payload: {
      adId: 'ad-1',
      actionId: 'action-1',
      executionId: 'exec-1',
      origin: 'USER_DIRECT',
      status: 'PARTIALLY_COMPLETED',
      actionType: 'DUPLICATE_AD',
      resultPlatformEntityId: '991',
      ...payload,
    },
  };
}

function buildListener() {
  const raised: Array<{ data: RaiseAlertJobData; jobId?: string }> = [];
  const dispatcher = {
    raise: (data: RaiseAlertJobData, jobId?: string) => {
      raised.push({ data, jobId });
      return Promise.resolve();
    },
  };

  return { listener: new ActionAlertListener(dispatcher as never), raised };
}

/**
 * Uma ação da Allva nunca aumenta gasto em silêncio. Quando uma escrita cria
 * entidade e não termina, alguém precisa saber — e com a urgência certa.
 */
describe('alertas de escrita que não terminou', () => {
  it('cópia possivelmente veiculando vira alerta CRÍTICO sobre a execução', async () => {
    const h = buildListener();

    await h.listener.onExecuted(executed({ exposureRisk: true }));

    expect(h.raised).toHaveLength(1);
    expect(h.raised[0].data).toMatchObject({
      type: 'ACTION_PARTIALLY_COMPLETED',
      severity: 'CRITICAL',
      subject: { kind: 'ACTION_EXECUTION', actionExecutionId: 'exec-1' },
    });
    expect(h.raised[0].data.message).toContain('991');
    expect(h.raised[0].data.message).toContain('pause-o');
  });

  it('sequência que parou em estado seguro vira AVISO', async () => {
    const h = buildListener();

    await h.listener.onExecuted(
      executed({ actionType: 'REPLACE_COPY', exposureRisk: false }),
    );

    expect(h.raised[0].data).toMatchObject({ severity: 'WARNING' });
    expect(h.raised[0].data.message).toContain('Nada passou a gastar a mais');
  });

  it('não alerta desfecho que não é parcial', async () => {
    const h = buildListener();

    await h.listener.onExecuted(executed({ status: 'SUCCEEDED' }));
    await h.listener.onExecuted(executed({ status: 'FAILED' }));

    expect(h.raised).toEqual([]);
  });
});
