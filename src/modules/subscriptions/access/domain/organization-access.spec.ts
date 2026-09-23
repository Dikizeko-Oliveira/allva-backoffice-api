import {
  AccountAccessFacts,
  OrganizationAccessFacts,
  mostPermissiveAccess,
  resolveAccountAccess,
  resolveOrganizationAccess,
  resolveOrganizationProductAccess,
} from './organization-access';

/**
 * As regras de acesso extraídas do resolver.
 *
 * O resolver tem a própria suíte, pelo contexto inteiro. Esta cobre as funções
 * diretamente porque a varredura dos jobs decide por elas — e uma regressão aqui
 * fecharia o sync de quem ainda está com o produto aberto, ou o contrário.
 */

const DIA = 24 * 60 * 60 * 1000;
const AGORA = new Date('2026-09-14T12:00:00Z');

function organizacao(
  overrides: Partial<OrganizationAccessFacts> = {},
): OrganizationAccessFacts {
  return { status: 'ACTIVE', trialEndsAt: null, contract: null, ...overrides };
}

function conta(
  overrides: Partial<AccountAccessFacts> = {},
): AccountAccessFacts {
  return {
    billingStatus: 'ACTIVE',
    accessStatus: 'ALLOWED',
    gracePeriodEndsAt: null,
    planType: 'PRO',
    expiresAt: new Date(AGORA.getTime() + 30 * DIA),
    ...overrides,
  };
}

function contrato(overrides: Record<string, unknown> = {}) {
  return {
    status: 'ACTIVE',
    startsAt: new Date(AGORA.getTime() - 30 * DIA),
    endsAt: new Date(AGORA.getTime() + 335 * DIA),
    gracePeriodDays: 7,
    oldestUnpaidDueAt: null,
    ...overrides,
  };
}

describe('acesso pela assinatura da organização', () => {
  it('teste aberto concede; teste vencido exige contratação', () => {
    const aberto = organizacao({
      status: 'TRIALING',
      trialEndsAt: new Date(AGORA.getTime() + DIA),
    });
    const vencido = organizacao({
      status: 'TRIALING',
      trialEndsAt: new Date(AGORA.getTime() - DIA),
    });

    expect(resolveOrganizationAccess(aberto, AGORA)).toBe('ALLOWED');
    expect(resolveOrganizationAccess(vencido, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('teste sem data de fim não vence', () => {
    const semFim = organizacao({ status: 'TRIALING', trialEndsAt: null });

    expect(resolveOrganizationAccess(semFim, AGORA)).toBe('ALLOWED');
  });

  it('sem contrato, decide pelo status da assinatura', () => {
    expect(
      resolveOrganizationAccess(organizacao({ status: 'CANCELED' }), AGORA),
    ).toBe('PAYMENT_REQUIRED');
    expect(
      resolveOrganizationAccess(organizacao({ status: 'PAST_DUE' }), AGORA),
    ).toBe('GRACE_PERIOD');
  });

  it('o contrato manda sobre o ACTIVE da assinatura', () => {
    const suspenso = organizacao({
      contract: contrato({ status: 'SUSPENDED' }),
    });

    expect(resolveOrganizationAccess(suspenso, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('dentro da tolerância do contrato o acesso continua aberto', () => {
    const emAtraso = organizacao({
      contract: contrato({
        oldestUnpaidDueAt: new Date(AGORA.getTime() - 3 * DIA),
      }),
    });

    expect(resolveOrganizationAccess(emAtraso, AGORA)).toBe('GRACE_PERIOD');
  });
});

describe('acesso pela assinatura pessoal', () => {
  it('usa a coluna persistida quando ela existe', () => {
    const emGraca = conta({
      billingStatus: 'PAST_DUE',
      accessStatus: 'GRACE_PERIOD',
      gracePeriodEndsAt: new Date(AGORA.getTime() + DIA),
    });

    expect(resolveAccountAccess(emGraca, AGORA)).toBe('GRACE_PERIOD');
  });

  it('sem a coluna, cai no mapeamento do billing', () => {
    const cancelada = conta({ billingStatus: 'CANCELED', accessStatus: null });

    expect(resolveAccountAccess(cancelada, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('a graça do PAST_DUE vencida fecha na hora', () => {
    const graçaVencida = conta({
      billingStatus: 'PAST_DUE',
      accessStatus: 'GRACE_PERIOD',
      gracePeriodEndsAt: new Date(AGORA.getTime() - DIA),
    });

    expect(resolveAccountAccess(graçaVencida, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('FREE vencido fecha; plano pago com expiresAt para trás não', () => {
    const passado = new Date(AGORA.getTime() - DIA);

    expect(
      resolveAccountAccess(
        conta({ planType: 'FREE', expiresAt: passado }),
        AGORA,
      ),
    ).toBe('PAYMENT_REQUIRED');
    expect(
      resolveAccountAccess(
        conta({ planType: 'PRO', expiresAt: passado }),
        AGORA,
      ),
    ).toBe('ALLOWED');
  });
});

describe('o mais permissivo', () => {
  it('lista vazia é BLOCKED: ninguém concedeu nada', () => {
    expect(mostPermissiveAccess([])).toBe('BLOCKED');
  });

  it('escolhe o de maior acesso', () => {
    expect(
      mostPermissiveAccess(['PAYMENT_REQUIRED', 'GRACE_PERIOD', 'BLOCKED']),
    ).toBe('GRACE_PERIOD');
  });
});

describe('acesso ao produto de uma organização, por qualquer caminho', () => {
  it('a assinatura da organização aberta basta', () => {
    expect(
      resolveOrganizationProductAccess({
        orgScopedEntitlement: true,
        subscription: organizacao(),
        accounts: [],
        now: AGORA,
      }),
    ).toBe('ALLOWED');
  });

  it('a assinatura pessoal de um membro abre, mesmo com a da organização vencida', () => {
    expect(
      resolveOrganizationProductAccess({
        orgScopedEntitlement: true,
        subscription: organizacao({ status: 'EXPIRED' }),
        accounts: [conta()],
        now: AGORA,
      }),
    ).toBe('ALLOWED');
  });

  it('com ORG_SCOPED_ENTITLEMENT desligado a assinatura da organização não conta', () => {
    expect(
      resolveOrganizationProductAccess({
        orgScopedEntitlement: false,
        subscription: organizacao(),
        accounts: [],
        now: AGORA,
      }),
    ).toBe('BLOCKED');
  });

  it('sem assinatura da organização e sem conta pagante, fica fechada', () => {
    expect(
      resolveOrganizationProductAccess({
        orgScopedEntitlement: true,
        subscription: null,
        accounts: [
          conta({
            billingStatus: 'CANCELED',
            accessStatus: 'PAYMENT_REQUIRED',
          }),
        ],
        now: AGORA,
      }),
    ).toBe('PAYMENT_REQUIRED');
  });
});
