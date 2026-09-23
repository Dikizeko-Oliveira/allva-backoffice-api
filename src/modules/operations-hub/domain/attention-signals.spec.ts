import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLES,
  permissionsForRole,
} from 'src/modules/accounts/domain/platform-rbac';
import {
  ATTENTION_SIGNALS,
  ATTENTION_SIGNAL_KEYS,
  signalsVisibleTo,
} from './attention-signals';

const keysFor = (role: string) =>
  signalsVisibleTo(permissionsForRole(role)).map((signal) => signal.key);

describe('catálogo de sinais do Operations Hub', () => {
  it('toda chave declarada tem exatamente uma definição', () => {
    const defined = ATTENTION_SIGNALS.map((signal) => signal.key);

    expect([...defined].sort()).toEqual([...ATTENTION_SIGNAL_KEYS].sort());
    expect(new Set(defined).size).toBe(defined.length);
  });

  it('toda permissão exigida existe na matriz de plataforma', () => {
    for (const signal of ATTENTION_SIGNALS) {
      expect(PLATFORM_PERMISSIONS).toContain(signal.permission);
    }
  });

  it('todo papel de plataforma enxerga ao menos um sinal', () => {
    // Senão o hub de algum papel nasce sem "requires attention" possível, e
    // ninguém percebe porque "vazio" parece "está tudo bem".
    for (const role of PLATFORM_ROLES) {
      expect(keysFor(role).length).toBeGreaterThan(0);
    }
  });

  it('cliente não enxerga nada', () => {
    expect(keysFor('USER')).toEqual([]);
  });
});

/**
 * As fronteiras da matriz, vistas pelo hub. Cada expectativa é a mesma
 * decisão de `platform-rbac.spec.ts`, na forma em que o operador a percebe.
 */
describe('cada área vê o próprio trabalho', () => {
  it('administração vê todos os sinais', () => {
    expect([...keysFor('ALLVA_ADMIN')].sort()).toEqual(
      [...ATTENTION_SIGNAL_KEYS].sort(),
    );
  });

  it('financeiro vê cobrança e assinatura, e nada de atendimento', () => {
    const keys = keysFor('ALLVA_FINANCE');

    expect(keys).toEqual(
      expect.arrayContaining([
        'billing.invoices_overdue',
        'subscriptions.past_due',
      ]),
    );
    expect(keys.some((key) => key.startsWith('support.'))).toBe(false);
    expect(keys.some((key) => key.startsWith('operations.'))).toBe(false);
  });

  it('suporte vê chamados, contatos e integrações, e nada de fatura', () => {
    const keys = keysFor('ALLVA_SUPPORT');

    expect(keys).toEqual(
      expect.arrayContaining([
        'support.tickets_unassigned',
        'contacts.unread',
        'integrations.unhealthy',
      ]),
    );
    expect(keys.some((key) => key.startsWith('billing.'))).toBe(false);
  });

  it('comercial vê só leads', () => {
    expect(keysFor('ALLVA_SALES')).toEqual(['leads.awaiting_qualification']);
  });

  it('contrato à espera de ativação é só de quem pode ativar', () => {
    for (const role of PLATFORM_ROLES) {
      expect(keysFor(role).includes('orgs.contracts_awaiting_activation')).toBe(
        role === 'ALLVA_ADMIN',
      );
    }
  });
});
