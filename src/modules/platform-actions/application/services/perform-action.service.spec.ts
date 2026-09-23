import { AuditLogService } from 'src/modules/audit/application';
import { AdActionGateway } from 'src/modules/platform-actions/domain/ports/ad-action.gateway';
import type { ExecutableAction } from 'src/modules/platform-actions/domain/ports/action-executions.repository';
import { ActionCapabilityRegistryService } from './action-capability-registry.service';
import {
  PerformActionService,
  backoffWithJitter,
} from './perform-action.service';

const action: ExecutableAction = {
  executionId: 'exec-1',
  organizationId: 'org-1',
  actionId: 'action-1',
  adId: 'ad-1',
  actionType: 'PAUSE_AD',
  origin: 'USER_DIRECT',
  recommendationId: null,
  level: 'AD',
  targetEntityType: 'AD',
  targetEntityId: 'ad-1',
  targetExternalId: '23847',
  parameters: { schemaVersion: 1, adId: 'ad-1' },
  previousState: { status: 'ACTIVE' },
  status: 'QUEUED',
  attempt: 1,
  dryRun: false,
  idempotencyKey: 'key-1',
  correlationId: 'corr-1',
  expiresAt: new Date(Date.now() + 900_000),
  requestedByAccountId: 'user-1',
  desiredStatus: 'PAUSED',
  platform: 'META',
  integrationId: 'int-1',
  adAccountId: 'adacc-1',
  accountCurrency: 'BRL',
  externalAccountId: 'act_1',
  organizationActionsEnabled: true,
  verificationAttempt: 0,
};

function buildHarness(
  overrides: {
    action?: Partial<ExecutableAction>;
    execute?: jest.Mock;
    observe?: jest.Mock;
    validate?: jest.Mock;
  } = {},
) {
  const execute =
    overrides.execute ??
    jest.fn().mockResolvedValue({ status: 'SUCCEEDED', retryable: false });

  const gateway = {
    platform: 'META',
    capabilities: () => [],
    execute,
    observe:
      overrides.observe ?? jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
    validate:
      overrides.validate ??
      jest
        .fn()
        .mockResolvedValue({ valid: true, depth: 'LOCAL_ONLY', failures: [] }),
  } as unknown as AdActionGateway;

  const executions = {
    loadForExecution: jest
      .fn()
      .mockResolvedValue({ ...action, ...overrides.action }),
    markRunning: jest.fn().mockResolvedValue(true),
    settle: jest.fn().mockResolvedValue(undefined),
  };

  const credentials = {
    resolveByIntegration: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const security = { record: jest.fn().mockResolvedValue(undefined) };
  const events = { emitFrom: jest.fn() };

  /**
   * A liquidação de recomendação é `null`-op aqui: a ação de teste nasce
   * `USER_DIRECT`, e §9.5 passo 5 só corre sobre plano de recomendação.
   */
  const settlement = { onExecutionSettled: jest.fn() };

  const service = new PerformActionService(
    executions as never,
    new ActionCapabilityRegistryService([gateway]),
    credentials as never,
    audit as unknown as AuditLogService,
    security as never,
    events as never,
    settlement as never,
  );

  return {
    service,
    executions,
    execute,
    audit,
    security,
    events,
    gateway,
    settlement,
  };
}

const ctx = { correlationId: 'corr-1', causationId: null };

describe('§13.4 — o worker de execução', () => {
  it('escreve, registra e manda verificar em T+90s', async () => {
    const harness = buildHarness();

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(harness.execute).toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'VERIFY', delayMs: 90_000 });
    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ad.action.executed' }),
    );
    // Entrega 15 — as duas trilhas, sempre.
    expect(harness.security.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'platform_write.executed' }),
    );
  });

  /**
   * **`desiredStatus` sobrevive ao sucesso.** A plataforma aceitou; ninguém
   * observou o efeito ainda. Limpá-lo aqui faria a tela dizer "pausado" com base
   * na nossa própria afirmação — que é exatamente o que a escada existe para não
   * aceitar.
   */
  it('não limpa o estado otimista ao ter sucesso', async () => {
    const harness = buildHarness();

    await harness.service.perform({ executionId: 'exec-1', attempt: 1, ctx });

    expect(harness.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SUCCEEDED' }),
    );
    expect(harness.executions.settle).not.toHaveBeenCalledWith(
      expect.objectContaining({ clearDesiredStatus: true }),
    );
  });

  /**
   * O kill switch é reconferido **no worker**. Entre aceitar a intenção e
   * escrever passam segundos ou minutos, e o propósito inteiro de um kill switch
   * é agir nesse intervalo — confiar na checagem do `POST` o transformaria em
   * "pare tudo que ainda não foi enfileirado".
   */
  it('não escreve quando o kill switch caiu depois do enfileiramento', async () => {
    const harness = buildHarness({
      action: { organizationActionsEnabled: false },
    });

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(harness.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: 'SETTLED', status: 'CANCELLED' });
    expect(harness.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({ clearDesiredStatus: true }),
    );
  });

  it('não reexecuta o que já saiu de QUEUED', async () => {
    const harness = buildHarness({ action: { status: 'SUCCEEDED' } });

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(outcome).toEqual({ kind: 'SKIPPED', reason: 'STATUS_SUCCEEDED' });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  /**
   * `markRunning` é compare-and-set no banco. Perder a corrida significa que
   * outra réplica pegou a execução — e escrever assim mesmo seria a segunda
   * chamada à plataforma que I2 existe para impedir.
   */
  it('desiste quando outra réplica reivindicou a execução', async () => {
    const harness = buildHarness();
    harness.executions.markRunning.mockResolvedValue(false);

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(outcome).toEqual({ kind: 'SKIPPED', reason: 'ALREADY_CLAIMED' });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('repete o que é reexecutável até a terceira tentativa', async () => {
    const harness = buildHarness({
      execute: jest.fn().mockResolvedValue({
        status: 'FAILED',
        retryable: true,
        errorCode: 'rate_limit',
      }),
    });

    const retry = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });
    expect(retry.kind).toBe('RETRY');

    const last = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 3,
      ctx,
    });
    expect(last.kind).toBe('SETTLED');
  });

  /**
   * Recusa não é falha temporária: repetir três vezes gastaria cota para chegar
   * ao mesmo lugar e adiaria o erro que o usuário precisa ver.
   */
  it('não repete o que a plataforma recusou', async () => {
    const harness = buildHarness({
      execute: jest.fn().mockResolvedValue({
        status: 'REJECTED_BY_PLATFORM',
        retryable: false,
        errorCode: 'bad_request',
      }),
    });

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(outcome).toMatchObject({ status: 'REJECTED_BY_PLATFORM' });
    expect(harness.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'REJECTED_BY_PLATFORM',
        clearDesiredStatus: true,
      }),
    );
    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ad.action.failed' }),
    );
    // Falha sobe na triagem: pode ser o primeiro sinal de credencial
    // comprometida, e não apenas uma recusa de negócio.
    expect(harness.security.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'platform_write.failed',
        severity: 'warning',
      }),
    );
  });

  it('valida sem tocar na plataforma quando é dry-run', async () => {
    const harness = buildHarness({ action: { dryRun: true } });

    await harness.service.perform({ executionId: 'exec-1', attempt: 1, ctx });

    expect(harness.execute).not.toHaveBeenCalled();
  });

  /**
   * P3 — a origem viaja até o evento. Assumir `USER_DIRECT` faria uma execução
   * nascida de recomendação chegar ao consumidor sem o vínculo que P8 mede.
   */
  it('emite o evento com a origem real da ação', async () => {
    const harness = buildHarness({ action: { origin: 'RECOMMENDATION' } });

    await harness.service.perform({ executionId: 'exec-1', attempt: 1, ctx });

    expect(harness.events.emitFrom).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      'action.executed',
      expect.objectContaining({
        origin: 'RECOMMENDATION',
        status: 'SUCCEEDED',
      }),
    );
  });

  /**
   * A leitura fresca alimenta a reversão de §9.6. Falhar nela não pode impedir
   * a escrita: ficamos com o `previousState` local, que é pior do que a leitura
   * fresca e melhor do que nada.
   */
  it('escreve mesmo quando a leitura prévia da plataforma falha', async () => {
    const harness = buildHarness({
      observe: jest.fn().mockRejectedValue(new Error('timeout')),
    });

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(harness.execute).toHaveBeenCalled();
    expect(outcome.kind).toBe('VERIFY');
  });

  /**
   * A plataforma criou e a sequência não terminou. Repetir criaria outra
   * entidade, e esconder como falha apagaria justamente o anúncio que precisa
   * de atenção.
   */
  it('assenta PARTIALLY_COMPLETED sem repetir, com o id criado e trilha crítica', async () => {
    const harness = buildHarness({
      action: { actionType: 'DUPLICATE_AD', desiredStatus: null },
      execute: jest.fn().mockResolvedValue({
        status: 'PARTIALLY_COMPLETED',
        exposureRisk: true,
        platformEntityId: '991',
        errorCode: 'COPY_PAUSE_UNCONFIRMED',
        errorMessage: 'pausa não confirmada',
        retryable: false,
      }),
    });

    const outcome = await harness.service.perform({
      executionId: 'exec-1',
      attempt: 1,
      ctx,
    });

    expect(outcome).toMatchObject({
      kind: 'SETTLED',
      status: 'PARTIALLY_COMPLETED',
    });
    expect(harness.executions.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'PARTIALLY_COMPLETED',
        resultPlatformEntityId: '991',
        errorCode: 'COPY_PAUSE_UNCONFIRMED',
      }),
    );
    expect(harness.security.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'platform_write.failed',
        severity: 'critical',
      }),
    );
    expect(harness.events.emitFrom).toHaveBeenCalledWith(
      expect.anything(),
      'action.executed',
      expect.objectContaining({
        status: 'PARTIALLY_COMPLETED',
        resultPlatformEntityId: '991',
        exposureRisk: true,
      }),
    );
  });

  it('sem risco de exposição, a trilha de segurança fica em aviso', async () => {
    const harness = buildHarness({
      execute: jest.fn().mockResolvedValue({
        status: 'PARTIALLY_COMPLETED',
        exposureRisk: false,
        platformEntityId: '991',
        retryable: false,
      }),
    });

    await harness.service.perform({ executionId: 'exec-1', attempt: 1, ctx });

    expect(harness.security.record).toHaveBeenCalledWith(
      expect.objectContaining({ severity: 'warning' }),
    );
    expect(harness.events.emitFrom).toHaveBeenCalledWith(
      expect.anything(),
      'action.executed',
      expect.not.objectContaining({ exposureRisk: true }),
    );
  });
});

describe('backoff com jitter (§13.4)', () => {
  it('cresce exponencialmente entre as tentativas', () => {
    const first = medianOf(() => backoffWithJitter(1));
    const second = medianOf(() => backoffWithJitter(2));

    expect(second).toBeGreaterThan(first);
  });

  /**
   * Sem jitter, N execuções que caíram pela mesma indisponibilidade voltam no
   * mesmo milissegundo — e a segunda rajada é maior que a primeira, porque a
   * fila acumulou enquanto a plataforma estava fora.
   */
  it('espalha as tentativas em vez de sincronizá-las', () => {
    const delays = new Set(
      Array.from({ length: 50 }, () => backoffWithJitter(1)),
    );

    expect(delays.size).toBeGreaterThan(1);
  });

  it('nunca devolve atraso não positivo', () => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      expect(backoffWithJitter(attempt)).toBeGreaterThan(0);
    }
  });
});

function medianOf(fn: () => number): number {
  const values = Array.from({ length: 41 }, fn).sort((a, b) => a - b);
  return values[20];
}
