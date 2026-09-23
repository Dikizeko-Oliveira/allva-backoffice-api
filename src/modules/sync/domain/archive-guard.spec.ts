import { evaluateArchiveGuard, StepResult } from './archive-guard';

/**
 * **O teste mais importante do sprint.**
 *
 * A guarda de §8.2 é o que separa "não vimos este anúncio" de "ele não existe
 * mais". Sem ela, uma reconexão com escopo menor arquiva milhares de anúncios
 * ativos, fecha todo o desperdício aberto como resolvido e zera o número de capa
 * — e o usuário abre o produto para descobrir que o problema dele sumiu,
 * enquanto o dinheiro continua saindo.
 */

const completeSteps: StepResult[] = [
  { step: 'STRUCTURE', status: 'SUCCEEDED' },
  { step: 'UPSERT', status: 'SUCCEEDED' },
  { step: 'METRICS', status: 'SUCCEEDED' },
];

describe('guarda de arquivamento (§8.2 passo 9)', () => {
  it('autoriza quando a leitura foi completa e a conta está saudável', () => {
    const verdict = evaluateArchiveGuard({
      wasComplete: true,
      stepResults: completeSteps,
      health: 'HEALTHY',
    });

    expect(verdict.allowed).toBe(true);
  });

  it('recusa quando a resposta da plataforma veio truncada', () => {
    const verdict = evaluateArchiveGuard({
      wasComplete: false,
      stepResults: completeSteps,
      health: 'HEALTHY',
    });

    expect(verdict).toMatchObject({
      allowed: false,
      code: 'INCOMPLETE_RESPONSE',
    });
  });

  it.each(['STRUCTURE', 'UPSERT', 'METRICS'] as const)(
    'recusa quando a etapa %s falhou',
    (step) => {
      const verdict = evaluateArchiveGuard({
        wasComplete: true,
        stepResults: completeSteps.map((result) =>
          result.step === step
            ? { ...result, status: 'FAILED' as const }
            : result,
        ),
        health: 'HEALTHY',
      });

      expect(verdict).toMatchObject({ allowed: false, code: 'STEP_FAILED' });
    },
  );

  it('recusa quando uma etapa obrigatória nem chegou a rodar', () => {
    // Uma etapa ausente não é uma etapa bem-sucedida. Tratar ausência como
    // sucesso é como um `return` antecipado passaria a autorizar arquivamento.
    const verdict = evaluateArchiveGuard({
      wasComplete: true,
      stepResults: [{ step: 'STRUCTURE', status: 'SUCCEEDED' }],
      health: 'HEALTHY',
    });

    expect(verdict).toMatchObject({ allowed: false, code: 'STEP_FAILED' });
  });

  it.each(['DEGRADED', 'UNREACHABLE'] as const)(
    'recusa em conta %s, mesmo com leitura completa (§8.7)',
    (health) => {
      const verdict = evaluateArchiveGuard({
        wasComplete: true,
        stepResults: completeSteps,
        health,
      });

      expect(verdict).toMatchObject({
        allowed: false,
        code: 'ACCOUNT_NOT_HEALTHY',
      });
    },
  );

  it('sempre devolve o motivo quando recusa', () => {
    // Uma guarda silenciosa é indistinguível de um bug que esqueceu de
    // arquivar. O motivo é o que vira `AD_ARCHIVE_SUPPRESSED` sobre a conta.
    const verdict = evaluateArchiveGuard({
      wasComplete: false,
      stepResults: [],
      health: 'HEALTHY',
    });

    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason.length).toBeGreaterThan(10);
    }
  });
});
