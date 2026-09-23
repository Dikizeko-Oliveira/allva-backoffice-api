import { IntegrationRevocationWorker } from './integration-revocation.worker';

/**
 * O worker só decide uma coisa: se o job volta para a fila.
 *
 * Falha de escrita volta — a tentativa seguinte pula o que já saiu de conexão.
 * A plataforma recusar a revogação não volta: a credencial já está desconectada
 * aqui, e tentar de novo não muda a resposta dela.
 */
function harness(outcome: {
  disconnected: number;
  revoked: number;
  failed: number;
}) {
  const disconnection = {
    disconnectOrganization: jest.fn().mockResolvedValue(outcome),
  };
  const worker = new IntegrationRevocationWorker(disconnection as never);

  jest.spyOn((worker as any).logger, 'log').mockImplementation(() => undefined);

  const job = {
    data: {
      ctx: { correlationId: 'corr-1', causationId: 'evt-1' },
      organizationId: 'org-1',
      actorId: 'acc-1',
    },
  };

  return { worker, disconnection, job };
}

describe('worker de revogação das credenciais de uma organização', () => {
  it('conclui quando toda credencial saiu de conexão, mesmo sem a plataforma confirmar', async () => {
    const h = harness({ disconnected: 2, revoked: 1, failed: 0 });

    await expect(h.worker.handle(h.job as never)).resolves.toBeUndefined();
    expect(h.disconnection.disconnectOrganization).toHaveBeenCalledWith(
      'org-1',
      'acc-1',
    );
  });

  it('devolve o job à fila quando alguma credencial não foi desconectada', async () => {
    const h = harness({ disconnected: 1, revoked: 1, failed: 1 });

    await expect(h.worker.handle(h.job as never)).rejects.toThrow(
      'não foram desconectadas',
    );
  });
});
