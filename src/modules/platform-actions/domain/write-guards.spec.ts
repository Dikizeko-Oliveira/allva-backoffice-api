import type { ActionAvailability } from './availability';
import {
  ConsentState,
  WriteGuardInput,
  evaluateWriteGuards,
} from './write-guards';

const available: ActionAvailability = { available: true };

const granted: ConsentState = {
  status: 'GRANTED',
  consentedActionTypes: ['PAUSE_AD', 'ENABLE_AD'],
};

function guards(overrides: Partial<WriteGuardInput> = {}) {
  return evaluateWriteGuards({
    installationEnabled: true,
    planEntitlement: { allowed: true },
    organizationActionsEnabled: true,
    consent: granted,
    actionType: 'PAUSE_AD',
    availability: available,
    dailyCap: { limit: null, usedToday: 0 },
    rateLimit: { limit: 30, usedInWindow: 0, windowSeconds: 60 },
    ...overrides,
  });
}

function failureOf(verdict: ReturnType<typeof guards>) {
  if (verdict.allowed) throw new Error('esperava recusa');
  return verdict.failure;
}

describe('P5 — a cadeia de guardas de escrita', () => {
  it('libera quando todas as condições estão satisfeitas', () => {
    expect(guards().allowed).toBe(true);
  });

  it('recusa quando a instalação não escreve', () => {
    const failure = failureOf(guards({ installationEnabled: false }));

    expect(failure.code).toBe('PLATFORM_ACTIONS_DISABLED');
    expect(failure.category).toBe('KILL_SWITCH');
  });

  it('recusa quando a organização desligou as ações', () => {
    const failure = failureOf(guards({ organizationActionsEnabled: false }));

    expect(failure.code).toBe('ORGANIZATION_ACTIONS_DISABLED');
    expect(failure.category).toBe('KILL_SWITCH');
  });

  /**
   * O kill switch precisa desligar **em menos de uma requisição** (gate de
   * saída). Isso só vale se ele vier antes de tudo que possa passar: uma
   * organização que desligou a escrita não pode ser liberada porque o
   * consentimento estava em dia.
   */
  it('deixa o kill switch vencer o consentimento válido', () => {
    const failure = failureOf(
      guards({
        organizationActionsEnabled: false,
        consent: { status: 'ABSENT' },
      }),
    );

    expect(failure.code).toBe('ORGANIZATION_ACTIONS_DISABLED');
  });

  describe('consentimento (§13.5)', () => {
    it('recusa sem consentimento registrado', () => {
      const failure = failureOf(guards({ consent: { status: 'ABSENT' } }));

      expect(failure.code).toBe('WRITE_CONSENT_REQUIRED');
      expect(failure.category).toBe('CONSENT_REQUIRED');
    });

    it('recusa consentimento revogado, e diz quando', () => {
      const revokedAt = new Date('2026-07-01T10:00:00Z');
      const failure = failureOf(
        guards({ consent: { status: 'REVOKED', revokedAt } }),
      );

      expect(failure.code).toBe('WRITE_CONSENT_REVOKED');
      expect(failure.details?.revokedAt).toBe(revokedAt.toISOString());
    });

    /**
     * Autorizar a pausar não é autorizar a mexer em orçamento. Tratar os dois
     * como o mesmo "sim" transformaria um consentimento estreito num cheque em
     * branco — e é exatamente o tipo de ação cujo estrago o consentimento
     * existe para limitar.
     */
    it('recusa tipo de ação fora do que foi consentido', () => {
      const failure = failureOf(guards({ actionType: 'ADJUST_AD_SET_BUDGET' }));

      expect(failure.code).toBe('ACTION_TYPE_NOT_CONSENTED');
      expect(failure.details?.actionType).toBe('ADJUST_AD_SET_BUDGET');
    });
  });

  describe('disponibilidade traduzida para erro tipado (§7.0.4)', () => {
    it.each([
      ['WRITE_IN_FLIGHT', 'WRITE_IN_FLIGHT', 'WRITE_IN_FLIGHT'],
      [
        'UNSUPPORTED_BY_PLATFORM',
        'ACTION_UNSUPPORTED',
        'UNSUPPORTED_BY_PLATFORM',
      ],
      ['TERMINAL_STATE', 'TARGET_IN_TERMINAL_STATE', 'UNSUPPORTED_BY_PLATFORM'],
      [
        'SYNC_UNRELIABLE',
        'TARGET_OBSERVATION_STALE',
        'INTEGRATION_UNREACHABLE',
      ],
      [
        'ALREADY_IN_TARGET_STATE',
        'TARGET_ALREADY_IN_STATE',
        'PRECONDITION_FAILED',
      ],
    ])('mapeia %s para %s', (reason, code, category) => {
      const failure = failureOf(
        guards({
          availability: {
            available: false,
            reason: reason as ActionAvailability['reason'],
            detail: 'detalhe',
          },
        }),
      );

      expect(failure.code).toBe(code);
      expect(failure.category).toBe(category);
    });
  });

  describe('rajada por organização (C10)', () => {
    /**
     * Teto e rajada medem coisas diferentes: o primeiro limita **quanto** uma
     * organização move num dia, o segundo **a que velocidade**. Um script em
     * laço que pause quinhentos anúncios em dez segundos fica abaixo de um teto
     * diário de mil e ainda assim é o incidente que R1 descreve.
     */
    it('recusa acima do limite por minuto, mesmo longe do teto diário', () => {
      const failure = failureOf(
        guards({
          rateLimit: { limit: 30, usedInWindow: 30, windowSeconds: 60 },
          dailyCap: { limit: 1000, usedToday: 30 },
        }),
      );

      expect(failure.code).toBe('ACTION_RATE_LIMIT_EXCEEDED');
      expect(failure.category).toBe('RATE_LIMITED');
    });

    /**
     * A rajada vem antes do teto diário porque é a que passa em trinta
     * segundos. Reportar o teto primeiro mandaria alguém esperar até amanhã por
     * um bloqueio que se resolve esperando meio minuto.
     */
    it('reporta a rajada antes do teto diário quando os dois estouram', () => {
      const failure = failureOf(
        guards({
          rateLimit: { limit: 30, usedInWindow: 30, windowSeconds: 60 },
          dailyCap: { limit: 50, usedToday: 50 },
        }),
      );

      expect(failure.code).toBe('ACTION_RATE_LIMIT_EXCEEDED');
    });

    it('libera abaixo do limite', () => {
      expect(
        guards({
          rateLimit: { limit: 30, usedInWindow: 29, windowSeconds: 60 },
        }).allowed,
      ).toBe(true);
    });
  });

  describe('teto diário (C10)', () => {
    it('recusa ao atingir o teto, com os números na resposta', () => {
      const failure = failureOf(
        guards({ dailyCap: { limit: 50, usedToday: 50 } }),
      );

      expect(failure.code).toBe('ACTION_DAILY_CAP_REACHED');
      expect(failure.category).toBe('RATE_LIMITED');
      expect(failure.details).toMatchObject({ limit: 50, usedToday: 50 });
    });

    it('libera abaixo do teto', () => {
      expect(guards({ dailyCap: { limit: 50, usedToday: 49 } }).allowed).toBe(
        true,
      );
    });

    /**
     * `null` é ausência de teto, não teto zero. Colapsá-los faria toda
     * organização que nunca configurou o limite parar de escrever — e o sintoma
     * seria "o produto não funciona", não "o teto foi atingido".
     */
    it('trata teto ausente como ausência de teto', () => {
      expect(
        guards({ dailyCap: { limit: null, usedToday: 10_000 } }).allowed,
      ).toBe(true);
    });

    it('deixa o teto por último — ele é o único que muda sozinho', () => {
      const failure = failureOf(
        guards({
          dailyCap: { limit: 1, usedToday: 5 },
          consent: { status: 'ABSENT' },
        }),
      );

      expect(failure.code).toBe('WRITE_CONSENT_REQUIRED');
    });
  });
});
