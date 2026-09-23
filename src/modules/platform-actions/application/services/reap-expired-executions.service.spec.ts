import { AuditLogService } from 'src/modules/audit/application';
import { ReapExpiredExecutionsService } from './reap-expired-executions.service';

function buildHarness(expired: unknown[] = []) {
  const executions = {
    findExpired: jest.fn().mockResolvedValue(expired),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const settlement = { onExecutionSettled: jest.fn() };

  return {
    service: new ReapExpiredExecutionsService(
      executions as never,
      audit as unknown as AuditLogService,
      settlement as never,
    ),
    executions,
    audit,
    settlement,
  };
}

const queued = {
  executionId: 'exec-1',
  organizationId: 'org-1',
  adId: 'ad-1',
  attempt: 1,
  status: 'QUEUED' as const,
  recommendationId: null,
  requestedByAccountId: 'user-1',
};

describe('C2 / ⊕6 — a varredura de expiresAt', () => {
  it('não faz nada quando não há execução vencida', async () => {
    const harness = buildHarness([]);

    const result = await harness.service.reap(new Date());

    expect(result.reaped).toBe(0);
    expect(harness.executions.settle).not.toHaveBeenCalled();
  });

  /**
   * O caminho de saída de um estado não terminal (§16.16). Sem ele, uma execução
   * travada segura `action_executions_inflight_unique` para sempre e o alvo fica
   * irrescrevível — toda tentativa nova recebe `WRITE_IN_FLIGHT` apontando para
   * algo que ninguém vai processar.
   */
  it('leva a execução travada a estado terminal e libera I2', async () => {
    const harness = buildHarness([queued]);

    const result = await harness.service.reap(new Date());

    expect(result.reaped).toBe(1);
    expect(harness.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'exec-1',
        status: 'CANCELLED',
        errorCode: 'EXECUTION_EXPIRED',
        clearDesiredStatus: true,
      }),
    );
  });

  /**
   * **`CANCELLED`, não `FAILED`.** Uma execução em `RUNNING` pode ter chamado a
   * plataforma e morrido antes de gravar o desfecho. `FAILED` afirmaria que a
   * escrita não pegou — e é exatamente o que ninguém pode afirmar aqui.
   */
  it('não afirma que a escrita falhou quando ela estava em andamento', async () => {
    const harness = buildHarness([{ ...queued, status: 'RUNNING' as const }]);

    await harness.service.reap(new Date());

    const call = harness.executions.settle.mock.calls[0][0] as {
      status: string;
      errorMessage: string;
    };

    expect(call.status).toBe('CANCELLED');
    expect(call.errorMessage).toContain('não é possível afirmar');
  });

  it('registra cada recolhimento na trilha, com o estado em que estava', async () => {
    const harness = buildHarness([{ ...queued, status: 'RUNNING' as const }]);

    await harness.service.reap(new Date());

    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'ad.action.failed',
        metadata: expect.objectContaining({
          reason: 'EXECUTION_EXPIRED',
          statusWhenReaped: 'RUNNING',
        }),
      }),
    );
  });

  /**
   * Os anúncios voltam para quem pode falar sobre eles: `platform-actions` não
   * sai de `PENDING_WRITE` (§3.5), e este é justamente o caso em que reler mais
   * importa — é o único em que não sabemos o que a plataforma tem.
   */
  it('devolve os anúncios afetados para o sync reler', async () => {
    const harness = buildHarness([
      queued,
      { ...queued, executionId: 'exec-2', adId: 'ad-2' },
    ]);

    const result = await harness.service.reap(new Date());

    expect(result.adIds).toEqual(['ad-1', 'ad-2']);
  });
});
