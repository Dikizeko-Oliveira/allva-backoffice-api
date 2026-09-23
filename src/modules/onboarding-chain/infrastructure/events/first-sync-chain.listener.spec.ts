import type { SweepMode } from 'src/modules/subscriptions/access/domain/sweep-mode';
import { FirstSyncChainListener } from './first-sync-chain.listener';

/**
 * A cadeia que a primeira sincronização acorda (F3).
 *
 * O ponto sob teste não é "enfileirou três coisas": é a **ordem** e o passo que
 * mais fácil se esquece. Sem `analysis-scope` antes do scoring,
 * `listScorable` volta vazio e o serviço retorna sem escrever nem logar — o
 * sintoma exato de "os jobs rodaram e as tabelas continuam vazias".
 */
function buildHarness(mode: SweepMode = 'FULL') {
  const calls: string[] = [];

  const analysisScope = {
    executeForOrganization: jest.fn().mockImplementation(() => {
      calls.push('scope');
      return Promise.resolve({
        organizations: 1,
        eligible: 1,
        excludedByPlanLimit: 0,
      });
    }),
  };

  const scoring = {
    score: jest.fn().mockImplementation(() => {
      calls.push('scoring');
      return Promise.resolve();
    }),
  };

  const waste = {
    detect: jest.fn().mockImplementation(() => {
      calls.push('waste');
      return Promise.resolve();
    }),
  };

  const recommendations = {
    generate: jest.fn().mockImplementation(() => {
      calls.push('recommendations');
      return Promise.resolve();
    }),
  };

  const sweep = {
    modesFor: jest.fn().mockResolvedValue(new Map([['org-1', mode]])),
  };

  return {
    listener: new FirstSyncChainListener(
      analysisScope as never,
      scoring as never,
      waste as never,
      recommendations as never,
      sweep as never,
    ),
    calls,
    analysisScope,
    scoring,
    waste,
    recommendations,
  };
}

const event = {
  name: 'ad_account.first_sync_completed' as const,
  organizationId: 'org-1',
  correlationId: 'corr-1',
  occurredAt: new Date(),
  payload: {
    adAccountId: 'conta-1',
    organizationId: 'org-1',
    platform: 'META' as const,
  },
} as never;

describe('cadeia da primeira sincronização', () => {
  it('carimba a régua do plano antes de pontuar', async () => {
    const h = buildHarness();

    await h.listener.onFirstSync(event);

    expect(h.calls).toEqual(['scope', 'scoring', 'waste', 'recommendations']);
    expect(h.analysisScope.executeForOrganization).toHaveBeenCalledWith(
      'org-1',
    );
  });

  it('pontua a conta que sincronizou e recomenda para a organização', async () => {
    const h = buildHarness();

    await h.listener.onFirstSync(event);

    expect(h.scoring.score).toHaveBeenCalledWith(
      expect.objectContaining({ adAccountId: 'conta-1' }),
    );
    expect(h.recommendations.generate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1' }),
      expect.any(Number),
    );
  });

  it('dá folga aos degraus que dependem do anterior', async () => {
    const h = buildHarness();

    await h.listener.onFirstSync(event);

    const [, wasteDelay] = h.waste.detect.mock.calls[0];
    const [, recsDelay] = h.recommendations.generate.mock.calls[0];

    // Chegar cedo demais custa um `SKIPPED`, que é readquirível — mas dar folga
    // é o que faz o caminho feliz entregar em minutos.
    expect(wasteDelay).toBeGreaterThan(0);
    expect(recsDelay).toBeGreaterThan(wasteDelay as number);
  });

  it('não acorda a cadeia para organização sem acesso', async () => {
    // A primeira varredura de uma conta pode cair na janela de sync diário de
    // quem acabou de perder acesso: o número chega, a análise não.
    for (const mode of ['DAILY_SYNC_ONLY', 'NONE'] as const) {
      const h = buildHarness(mode);

      await h.listener.onFirstSync(event);

      expect(h.calls).toEqual([]);
    }
  });
});
