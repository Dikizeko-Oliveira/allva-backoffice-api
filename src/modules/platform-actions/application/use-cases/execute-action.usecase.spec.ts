import { AuditLogService } from 'src/modules/audit/application';
import { AdActionGateway } from 'src/modules/platform-actions/domain/ports/ad-action.gateway';
import type { ActionTargetView } from 'src/modules/platform-actions/domain/ports/action-targets.repository';
import { ActionCapabilityRegistryService } from 'src/modules/platform-actions/application/services/action-capability-registry.service';
import { ActionEnqueueService } from 'src/modules/platform-actions/application/services/action-enqueue.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { ActionGuardEvaluatorService } from 'src/modules/platform-actions/application/services/action-guard-evaluator.service';
import { ExecuteActionUseCase } from './execute-action.usecase';
import { contentDigest } from 'src/modules/platform-actions/domain/idempotency';
import type { EnvService } from 'src/shared/infrastructure/config/env.service';

/**
 * **O teste de P5 "por caminho"** — o gate de saída de A2-S7.
 *
 * *"Nenhuma ação executa sem RBAC ok, kill switch off, consentimento
 * registrado, revalidação e audit gravado."* RBAC fica no guard HTTP; as outras
 * quatro passam por aqui, e a montagem é deliberadamente **real**: registry,
 * avaliador de guardas, serviço de enfileiramento e o domínio inteiro são as
 * classes de produção. Só repositório e relógio são falsos.
 *
 * Trocar isso por mocks do avaliador testaria que o use case chama um método —
 * não que a escrita é impossível sem as guardas. E é a segunda coisa que o gate
 * pede.
 */

const target: ActionTargetView = {
  adId: 'ad-1',
  organizationId: 'org-1',
  accountId: 'acc-1',
  platform: 'META',
  adAccountId: 'adacc-1',
  integrationId: 'int-1',
  accountCurrency: 'BRL',
  externalAccountId: 'act_1',
  externalAdId: '23847',
  unitKind: 'AD',
  creativeFormat: null,
  observedStatus: 'ACTIVE',
  desiredStatus: null,
  syncState: 'IN_SYNC',
  version: 1,
  adSet: { id: 'set-1', externalId: '99881' },
  campaign: { id: 'camp-1', externalId: '77001' },
  actionsEnabled: true,
};

const gateway = {
  platform: 'META',
  capabilities: () => [
    {
      type: 'REPLACE_COPY',
      supported: true,
      reversible: false,
      requiresRecreate: true,
      createsEntity: true,
      validationDepth: 'PLATFORM',
    },
    {
      type: 'PAUSE_AD',
      supported: true,
      reversible: true,
      requiresRecreate: false,
      createsEntity: false,
      validationDepth: 'LOCAL_ONLY',
    },
  ],
} as unknown as AdActionGateway;

type Harness = ReturnType<typeof buildHarness>;

function buildHarness(
  overrides: {
    target?: Partial<ActionTargetView>;
    consent?: unknown;
    dailyCap?: number | null;
    usedToday?: number;
    installationEnabled?: boolean;
    dryRunOnly?: boolean;
    rateLimit?: number;
    planType?: 'FREE' | 'STARTER' | 'PRO' | 'ENTERPRISE';
    existingKey?: { executionId: string; requestDigest: string } | null;
  } = {},
) {
  const enqueue = jest.fn().mockResolvedValue({
    kind: 'ENQUEUED',
    executionId: 'exec-1',
    actionId: 'action-1',
  });

  const executions = {
    enqueue,
    findByIdempotencyKey: jest
      .fn()
      .mockResolvedValue(overrides.existingKey ?? null),
    findExecution: jest.fn().mockResolvedValue({
      executionId: 'exec-1',
      actionId: 'action-1',
      status: 'QUEUED',
      observedStatus: 'ACTIVE',
      desiredStatus: 'PAUSED',
    }),
    countExecutionsSince: jest.fn().mockResolvedValue(overrides.usedToday ?? 0),
    loadForExecution: jest.fn().mockResolvedValue(null),
  };

  const targets = {
    findTarget: jest.fn().mockResolvedValue({ ...target, ...overrides.target }),
    findInFlightWrites: jest.fn().mockResolvedValue([]),
  };

  const consents = {
    stateFor: jest.fn().mockResolvedValue(
      overrides.consent ?? {
        status: 'GRANTED',
        consentedActionTypes: ['PAUSE_AD'],
      },
    ),
  };

  const settings = {
    actionDailyCap: jest.fn().mockResolvedValue(overrides.dailyCap ?? null),
  };

  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const dispatcher = { perform: jest.fn().mockResolvedValue(undefined) };

  /**
   * Um stub por chave, e não um ternário: com dois ramos, toda variável nova
   * caía no `else` e chegava ao domínio como `false` — foi assim que o limite de
   * rajada nasceu valendo zero e recusou tudo.
   */
  const env = {
    get: (key: string) =>
      ({
        PLATFORM_ACTIONS_ENABLED: overrides.installationEnabled ?? true,
        PLATFORM_ACTIONS_DRY_RUN_ONLY: overrides.dryRunOnly ?? false,
        PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE: overrides.rateLimit ?? 30,
      })[key],
  } as unknown as EnvService;

  const registry = new ActionCapabilityRegistryService([gateway]);
  const organizationPlan = {
    findPlanTypeByOrganizationId: jest
      .fn()
      .mockResolvedValue(overrides.planType ?? 'PRO'),
  };
  const guards = new ActionGuardEvaluatorService(
    targets as never,
    executions as never,
    consents as never,
    registry,
    settings as never,
    new PlanEntitlementService(
      organizationPlan as never,
      {
        findOverrides: jest.fn().mockResolvedValue({
          adAccounts: null,
          monitoredAds: null,
          seats: null,
        }),
      } as never,
      /**
       * Guarda liga/desliga não reserva cota — e o dublê que lança é o que
       * prova isso. Um que devolvesse número esconderia uma reserva indevida.
       */
      {
        reserve: jest.fn(() => {
          throw new Error('guarda liga/desliga não deve reservar cota');
        }),
        release: jest.fn(),
        read: jest.fn().mockResolvedValue(0),
      } as never,
    ),
    env,
  );
  const enqueueService = new ActionEnqueueService(
    executions as never,
    dispatcher as never,
    audit as unknown as AuditLogService,
  );

  const useCase = new ExecuteActionUseCase(
    targets as never,
    executions as never,
    registry,
    guards,
    enqueueService,
    env,
  );

  return { useCase, enqueue, audit, executions, targets, dispatcher };
}

function request(dryRun?: boolean, type = 'PAUSE_AD') {
  return {
    organizationId: 'org-1',
    accountId: 'user-1',
    adId: 'ad-1',
    body: {
      type: type as 'PAUSE_AD',
      parameters: { adId: 'ad-1' },
      ...(dryRun === undefined ? {} : { dryRun }),
    },
    idempotencyKey: 'key-1',
    correlationId: null,
    ipAddress: null,
    userAgent: null,
  };
}

async function refusalOf(harness: Harness, dryRun?: boolean, type?: string) {
  try {
    await harness.useCase.execute(request(dryRun, type));
  } catch (error) {
    return error as { code: string; category: string };
  }
  throw new Error('esperava recusa');
}

describe('P5 — nenhuma escrita sem as quatro guardas', () => {
  it('enfileira e audita quando tudo está em ordem', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute(request(false));

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(result.executionId).toBe('exec-1');
    expect(harness.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ad.action.requested' }),
    );
    // A fila recebe o pedido **depois** da linha: antes do commit, o worker
    // buscaria uma execução que o banco ainda não gravou.
    expect(harness.dispatcher.perform).toHaveBeenCalledWith(
      expect.objectContaining({ executionId: 'exec-1', attempt: 1 }),
    );
  });

  it('não escreve com o kill switch da organização desligado', async () => {
    const harness = buildHarness({ target: { actionsEnabled: false } });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('ORGANIZATION_ACTIONS_DISABLED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('não escreve com a escrita desligada na instalação', async () => {
    const harness = buildHarness({ installationEnabled: false });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('PLATFORM_ACTIONS_DISABLED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('não escreve sem consentimento registrado', async () => {
    const harness = buildHarness({ consent: { status: 'ABSENT' } });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('WRITE_CONSENT_REQUIRED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('não escreve tipo de ação fora do consentimento', async () => {
    const harness = buildHarness({
      consent: { status: 'GRANTED', consentedActionTypes: ['ENABLE_AD'] },
    });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('ACTION_TYPE_NOT_CONSENTED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  /**
   * A revalidação de premissa que §13.5 exige, na forma que o alvo permite: um
   * anúncio já pausado não é pausável, e a leitura vencida não autoriza decidir.
   */
  it('não escreve sobre alvo já no estado pedido', async () => {
    const harness = buildHarness({ target: { observedStatus: 'PAUSED' } });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('TARGET_ALREADY_IN_STATE');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('não escreve sobre observação vencida', async () => {
    const harness = buildHarness({ target: { syncState: 'STALE' } });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('TARGET_OBSERVATION_STALE');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('não escreve acima do teto diário (C10)', async () => {
    const harness = buildHarness({ dailyCap: 5, usedToday: 5 });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('ACTION_DAILY_CAP_REACHED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe('dry-run (§13.5)', () => {
  it('nunca enfileira, mesmo com tudo liberado', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute(request(true));

    expect(harness.enqueue).not.toHaveBeenCalled();
    expect(result.executionId).toBeNull();
    expect(result.body.data).toMatchObject({
      dryRun: true,
      wouldExecute: true,
    });
  });

  /**
   * O dry-run **relata** o bloqueio em vez de lançar. É a diferença entre uma
   * validação que serve para decidir e uma que obriga o usuário a descobrir um
   * obstáculo por requisição.
   */
  it('relata o bloqueio em vez de recusar', async () => {
    const harness = buildHarness({ consent: { status: 'ABSENT' } });

    const result = await harness.useCase.execute(request(true));

    expect(result.body.data).toMatchObject({
      wouldExecute: false,
      blockedBy: expect.objectContaining({ code: 'WRITE_CONSENT_REQUIRED' }),
    });
  });

  it('declara que a validação foi apenas local', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute(request(true));

    expect(result.body.data).toMatchObject({ validationDepth: 'LOCAL_ONLY' });
  });

  /** RP5: durante as duas semanas de observação, `dryRun: false` é recusado. */
  it('recusa escrita real sob dry-run obrigatório', async () => {
    const harness = buildHarness({ dryRunOnly: true });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('PLATFORM_WRITE_DRY_RUN_ONLY');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  /**
   * Não pedir nada é pedir dry-run quando a instalação está em observação. O
   * contrário faria um cliente desatualizado mover dinheiro por omissão.
   */
  it('usa o default da instalação quando o cliente não diz nada', async () => {
    const harness = buildHarness({ dryRunOnly: true });

    const result = await harness.useCase.execute(request(undefined));

    expect(result.body.data).toMatchObject({ dryRun: true });
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe('idempotência por tenant (A8, ⊕2)', () => {
  it('devolve o resultado original sem executar de novo', async () => {
    // O dígito é calculado pelo use case a partir do pedido; para simular um
    // replay legítimo é preciso o dígito **daquele** pedido, não um literal.
    const first = buildHarness();
    await first.useCase.execute(request(false));
    const digest = first.enqueue.mock.calls[0][0].requestDigest as string;

    const replay = buildHarness({
      existingKey: { executionId: 'exec-original', requestDigest: digest },
    });
    const result = await replay.useCase.execute(request(false));

    expect(replay.enqueue).not.toHaveBeenCalled();
    expect(result.body.data).toMatchObject({ replayed: true });
  });

  it('recusa a mesma chave com pedido diferente', async () => {
    const harness = buildHarness({
      existingKey: { executionId: 'exec-1', requestDigest: 'outro-digito' },
    });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  /**
   * O dígito separa dry-run de escrita real. Sem isso, reaproveitar a chave do
   * dry-run devolveria o resultado da validação — um `202` que nunca escreveu.
   */
  it('não confunde o dry-run com a escrita real na mesma chave', async () => {
    const real = buildHarness();
    await real.useCase.execute(request(false));
    const realDigest = real.enqueue.mock.calls[0][0].requestDigest as string;

    const harness = buildHarness({
      existingKey: { executionId: 'exec-dry', requestDigest: realDigest },
    });

    // Mesmo `idempotencyKey`, agora em dry-run: dígito diferente ⇒ recusa.
    const refusal = await refusalOf(harness, true);

    expect(refusal.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('gates de saída de A2-S7', () => {
  /**
   * *"Kill switch desliga em < 1 requisição."*
   *
   * A garantia não é do teste: é de `actionsEnabled` ser lido do banco a cada
   * pedido, sem cache. O teste prova que **não há** cache — duas chamadas
   * consecutivas no mesmo use case, com o banco respondendo diferente, dão
   * vereditos diferentes. Um cache de trinta segundos aqui seria a diferença
   * entre parar e "parar daqui a pouco", numa alavanca cujo único propósito é
   * ser usada quando algo já está errado.
   */
  it('honra o kill switch na requisição seguinte, sem cache', async () => {
    const harness = buildHarness();

    await harness.useCase.execute(request(false));
    expect(harness.enqueue).toHaveBeenCalledTimes(1);

    harness.targets.findTarget.mockResolvedValue({
      ...target,
      actionsEnabled: false,
    });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('ORGANIZATION_ACTIONS_DISABLED');
    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  /**
   * *"Chaves iguais em orgs diferentes não colidem."*
   *
   * A garantia estrutural é o índice `(organization_id, idempotency_key)`; o que
   * este teste cobre é o lado do código, que é onde ela se perde: uma busca que
   * esquecesse o `organizationId` faria a chave `retry-1` de uma organização
   * devolver a execução de outra — vazamento entre tenants disfarçado de replay.
   */
  it('escopa a busca de idempotência pela organização', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({
      ...request(false),
      organizationId: 'org-vizinha',
      idempotencyKey: 'chave-compartilhada',
    });

    expect(harness.executions.findByIdempotencyKey).toHaveBeenCalledWith({
      organizationId: 'org-vizinha',
      idempotencyKey: 'chave-compartilhada',
    });
  });

  /**
   * A mesma chave numa organização que nunca a usou é pedido novo, não replay:
   * o repositório escopado devolve `null` e a escrita segue.
   */
  it('deixa a mesma chave passar em organização diferente', async () => {
    const harness = buildHarness({ existingKey: null });

    const result = await harness.useCase.execute({
      ...request(false),
      organizationId: 'org-2',
      idempotencyKey: 'chave-compartilhada',
    });

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
    expect(result.executionId).toBe('exec-1');
  });
});

/**
 * R14 no caminho **individual** — o lote tem a própria guarda, e as duas
 * precisam existir: um cliente que não use lote escreveria texto de LLM sob a
 * marca do cliente sem ninguém ter confirmado.
 */
describe('R14 — conteúdo autoral no caminho individual', () => {
  /**
   * Consentimento cobrindo `REPLACE_COPY`: sem isso a cadeia recusa antes, em
   * `ACTION_TYPE_NOT_CONSENTED` — que é a ordem certa das guardas, e não o que
   * estes casos querem exercitar.
   */
  const consented = {
    consent: { status: 'GRANTED', consentedActionTypes: ['REPLACE_COPY'] },
  };

  function replaceCopy(overrides: Record<string, unknown> = {}) {
    return {
      ...request(false),
      body: {
        type: 'REPLACE_COPY' as const,
        parameters: {
          adId: 'ad-1',
          primaryText: 'Texto revisado',
          aiAuthored: true,
        },
        dryRun: false,
        ...overrides,
      },
    };
  }

  it('recusa texto de IA sem confirmação', async () => {
    const harness = buildHarness(consented);

    try {
      await harness.useCase.execute(replaceCopy());
      throw new Error('esperava recusa');
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        'AI_CONTENT_CONFIRMATION_REQUIRED',
      );
    }

    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  /**
   * O caso que um booleano de confirmação não pegaria: o usuário confirma, o
   * texto é regenerado, e o que vai ao ar não é o que alguém leu.
   */
  it('recusa quando o texto mudou depois da confirmação', async () => {
    const harness = buildHarness(consented);

    try {
      await harness.useCase.execute(
        replaceCopy({ confirmedContentDigest: 'digito-de-outro-texto' }),
      );
      throw new Error('esperava recusa');
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        'AI_CONTENT_CHANGED_AFTER_CONFIRMATION',
      );
    }

    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('deixa passar com o dígito do texto que vai ao ar', async () => {
    const harness = buildHarness(consented);

    await harness.useCase.execute(
      replaceCopy({ confirmedContentDigest: contentDigest('Texto revisado') }),
    );

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  /** Texto humano não precisa de confirmação: quem o escreveu já o leu. */
  it('não exige confirmação de texto escrito por gente', async () => {
    const harness = buildHarness(consented);

    await harness.useCase.execute(
      replaceCopy({
        parameters: {
          adId: 'ad-1',
          primaryText: 'Texto meu',
          aiAuthored: false,
        },
      }),
    );

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('rajada por organização (C10)', () => {
  /**
   * O teto diário responde "quanto"; a rajada responde "a que velocidade". Um
   * script em laço fica abaixo do primeiro e ainda assim é o incidente de R1.
   */
  it('recusa acima do limite por minuto', async () => {
    const harness = buildHarness({ rateLimit: 5, usedToday: 5 });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('ACTION_RATE_LIMIT_EXCEEDED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe('I2 — uma escrita em voo por alvo', () => {
  it('recusa quando o banco arbitra a corrida contra este pedido', async () => {
    const harness = buildHarness();
    harness.enqueue.mockResolvedValueOnce({
      kind: 'WRITE_IN_FLIGHT',
      inFlightExecutionId: 'exec-em-voo',
    });

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('WRITE_IN_FLIGHT');
    expect(refusal.category).toBe('WRITE_IN_FLIGHT');
  });

  it('reporta a escrita em voo já na avaliação, antes de tentar gravar', async () => {
    const harness = buildHarness();
    harness.targets.findInFlightWrites.mockResolvedValue([
      { executionId: 'exec-7', targetEntityType: 'AD', targetEntityId: 'ad-1' },
    ]);

    const refusal = await refusalOf(harness, false);

    expect(refusal.code).toBe('WRITE_IN_FLIGHT');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });
});

describe('o plano governa a superfície de escrita', () => {
  it('Individual não age acima do anúncio', async () => {
    const harness = buildHarness({ planType: 'STARTER' });

    const refusal = await refusalOf(harness, false, 'PAUSE_AD_SET');

    expect(refusal.code).toBe('PLAN_FEATURE_NOT_INCLUDED');
    expect(refusal.category).toBe('PLAN_LIMITED');
    expect(harness.enqueue).not.toHaveBeenCalled();
  });

  it('Individual continua agindo no anúncio', async () => {
    const harness = buildHarness({ planType: 'STARTER' });

    await harness.useCase.execute(request(false));

    expect(harness.enqueue).toHaveBeenCalledTimes(1);
  });

  it('o Profissional passa onde o Individual para', async () => {
    const harness = buildHarness({
      planType: 'PRO',
      consent: { status: 'GRANTED', consentedActionTypes: ['PAUSE_AD_SET'] },
    });

    const refusal = await refusalOf(harness, false, 'PAUSE_AD_SET');

    // Passa do plano e para adiante, no que o mundo diz — não no que se comprou.
    expect(refusal.code).not.toBe('PLAN_FEATURE_NOT_INCLUDED');
  });

  it('o plano precede o consentimento — pedir autorização não destravaria nada', async () => {
    // A ordem é a mesma lógica que põe o kill switch antes do consentimento:
    // quem não comprou a ação não deve ser mandado configurar consentimento.
    const harness = buildHarness({
      planType: 'STARTER',
      consent: { status: 'ABSENT' },
    });

    const refusal = await refusalOf(harness, false, 'PAUSE_AD_SET');

    expect(refusal.code).toBe('PLAN_FEATURE_NOT_INCLUDED');
  });

  it('dry-run relata o bloqueio de plano em vez de recusar', async () => {
    const harness = buildHarness({ planType: 'STARTER' });

    const result = await harness.useCase.execute(request(true, 'PAUSE_AD_SET'));

    expect(result.body.data).toMatchObject({
      wouldExecute: false,
      blockedBy: expect.objectContaining({
        code: 'PLAN_FEATURE_NOT_INCLUDED',
      }),
    });
  });

  it('a recusa aponta o plano que libera, não só o que falta', async () => {
    const harness = buildHarness({ planType: 'STARTER' });

    const refusal = (await refusalOf(harness, false, 'PAUSE_AD_SET')) as {
      remediation?: string;
    };

    expect(refusal.remediation).toContain('Profissional');
  });
});
