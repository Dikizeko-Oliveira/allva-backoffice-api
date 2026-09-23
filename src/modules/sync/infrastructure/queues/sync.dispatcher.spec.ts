import { SyncDispatcher } from './sync.dispatcher';
import { createRootJobContext } from 'src/shared/domain/events/job-context';

/**
 * Regressão da varredura completa engolida pela fila (F3).
 *
 * O `jobId` não distinguia varredura completa de incremental, então um pedido
 * de varredura completa era descartado em silêncio quando o cron horário já
 * tivesse enfileirado um incremental para a mesma conta naquela hora — mesma
 * conta, mesma hora, mesmo id. A conta recém-conectada continuava esperando a
 * madrugada, mas só às vezes, conforme o minuto em que o usuário clicasse.
 */
function buildHarness() {
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  return { dispatcher: new SyncDispatcher(queue as never), queue };
}

const base = { ctx: createRootJobContext(), adAccountId: 'conta-1' } as const;

describe('enfileirar ingest', () => {
  it('varredura completa e incremental não colidem na mesma hora', async () => {
    const h = buildHarness();

    await h.dispatcher.ingest({ ...base, trigger: 'SCHEDULE' });
    await h.dispatcher.ingest({
      ...base,
      trigger: 'MANUAL',
      forceFullScan: true,
    });

    const [incremental, full] = h.queue.add.mock.calls.map(
      (call) => (call[2] as { jobId: string }).jobId,
    );

    expect(incremental).not.toBe(full);
    expect(incremental).toContain(':inc:');
    expect(full).toContain(':full:');
  });

  it('dois pedidos do mesmo tipo continuam colapsando', async () => {
    const h = buildHarness();

    await h.dispatcher.ingest({ ...base, trigger: 'SCHEDULE' });
    await h.dispatcher.ingest({ ...base, trigger: 'SCHEDULE' });

    const ids = h.queue.add.mock.calls.map(
      (call) => (call[2] as { jobId: string }).jobId,
    );

    // A deduplicação barata continua valendo — ela só deixou de confundir dois
    // trabalhos diferentes.
    expect(ids[0]).toBe(ids[1]);
  });
});
