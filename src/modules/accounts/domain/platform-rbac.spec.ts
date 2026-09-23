import { ACCOUNT_ROLE_TYPE } from 'generated/prisma/client';
import {
  PLATFORM_PERMISSIONS,
  PLATFORM_ROLE_PERMISSIONS,
  PLATFORM_ROLES,
  isPlatformRole,
  permissionsForRole,
  roleHasPlatformPermission,
} from './platform-rbac';

/**
 * **A trava do passo 4.**
 *
 * `docs/platform-rbac.md` (backoffice) pede um teste que falhe se um papel
 * entrar no enum do banco sem entrada na matriz — é a única proteção contra
 * alguém, no futuro, fazer o `ALTER TYPE … ADD VALUE` sozinho. Sem ela, o
 * papel novo nasceria sem permissão nenhuma (a matriz fecha na dúvida), e o
 * defeito apareceria como "a conta nova não consegue nada" em produção.
 */
describe('paridade entre o enum do banco e a matriz', () => {
  const dbRoles = Object.values(ACCOUNT_ROLE_TYPE);

  it('todo papel de plataforma do banco tem linha na matriz', () => {
    const platformInDb = dbRoles.filter((role) => role !== 'USER');

    expect([...platformInDb].sort()).toEqual([...PLATFORM_ROLES].sort());
  });

  it('`USER` não é papel de plataforma', () => {
    expect(isPlatformRole('USER')).toBe(false);
    expect(permissionsForRole('USER')).toEqual([]);
  });
});

describe('fecha na dúvida', () => {
  it.each([null, undefined, '', 'USER', 'ALLVA_ROOT'])(
    '%p não tem permissão nenhuma',
    (role) => {
      for (const permission of PLATFORM_PERMISSIONS) {
        expect(roleHasPlatformPermission(role, permission)).toBe(false);
      }
    },
  );
});

/**
 * **A matriz é a do backoffice, fixada aqui.**
 *
 * Não é snapshot: cada expectativa é uma fronteira que foi decidida e está
 * escrita em `docs/platform-rbac.md`. Um snapshot seria atualizado com um
 * comando e ninguém leria o diff; estas quebram com o nome da decisão que
 * mudou.
 */
describe('as fronteiras decididas', () => {
  it('administração tem tudo, por enumeração', () => {
    expect([...PLATFORM_ROLE_PERMISSIONS.ALLVA_ADMIN].sort()).toEqual(
      [...PLATFORM_PERMISSIONS].sort(),
    );
  });

  it('só a administração concede papel — a permissão que se auto-multiplica', () => {
    for (const role of PLATFORM_ROLES) {
      expect(
        roleHasPlatformPermission(role, 'users:manage_platform_role'),
      ).toBe(role === 'ALLVA_ADMIN');
    }
  });

  it('só a administração ativa, suspende e cancela contrato (`orgs:manage`)', () => {
    for (const role of PLATFORM_ROLES) {
      expect(roleHasPlatformPermission(role, 'orgs:manage')).toBe(
        role === 'ALLVA_ADMIN',
      );
    }
  });

  it('limite contratado é do financeiro, não de operações', () => {
    expect(
      roleHasPlatformPermission('ALLVA_FINANCE', 'orgs:quota_manage'),
    ).toBe(true);
    expect(
      roleHasPlatformPermission('ALLVA_OPERATOR', 'orgs:quota_manage'),
    ).toBe(false);
  });

  /**
   * O motivo de os papéis existirem. Com `assertOperator` binário, qualquer
   * conta interna emitia fatura — inclusive a do suporte.
   */
  it('suporte não emite fatura, e financeiro não atende chamado', () => {
    expect(roleHasPlatformPermission('ALLVA_SUPPORT', 'billing:manage')).toBe(
      false,
    );
    expect(roleHasPlatformPermission('ALLVA_SUPPORT', 'support:manage')).toBe(
      true,
    );
    expect(roleHasPlatformPermission('ALLVA_FINANCE', 'support:manage')).toBe(
      false,
    );
    expect(roleHasPlatformPermission('ALLVA_FINANCE', 'billing:manage')).toBe(
      true,
    );
  });

  it('o suporte diagnostica integração, mas não reconecta credencial', () => {
    expect(
      roleHasPlatformPermission('ALLVA_SUPPORT', 'integrations:read'),
    ).toBe(true);
    expect(
      roleHasPlatformPermission('ALLVA_SUPPORT', 'integrations:manage'),
    ).toBe(false);
  });

  it('a trilha inteira é de administração e operações', () => {
    const withAudit = PLATFORM_ROLES.filter((role) =>
      roleHasPlatformPermission(role, 'audit:read'),
    );

    expect([...withAudit].sort()).toEqual(['ALLVA_ADMIN', 'ALLVA_OPERATOR']);
  });

  it('o comercial vê leads e organizações, e mais nada que mude dinheiro', () => {
    expect([...permissionsForRole('ALLVA_SALES')].sort()).toEqual(
      ['dashboard:read', 'leads:manage', 'leads:read', 'orgs:read'].sort(),
    );
  });

  it('toda permissão da matriz existe na lista canônica', () => {
    for (const role of PLATFORM_ROLES) {
      for (const permission of PLATFORM_ROLE_PERMISSIONS[role]) {
        expect(PLATFORM_PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe('permissionsForRole', () => {
  it('devolve cópia — quem recebe não muta a matriz', () => {
    const copy = permissionsForRole('ALLVA_SALES');
    copy.push('billing:manage');

    expect(roleHasPlatformPermission('ALLVA_SALES', 'billing:manage')).toBe(
      false,
    );
  });
});
