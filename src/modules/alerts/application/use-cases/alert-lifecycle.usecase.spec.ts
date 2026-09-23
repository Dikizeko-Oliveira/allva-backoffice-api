import { NotFoundException } from '@nestjs/common';
import {
  DismissAlertUseCase,
  GetAlertUseCase,
  MarkAlertReadUseCase,
  MarkAllAlertsReadUseCase,
  ResolveAlertUseCase,
} from './alert-use-cases';

/**
 * Todo use case de ciclo de vida resolve o escopo antes de agir. Desde A2-S1 o
 * escopo é a **organização** (`Alert.organizationId` é NOT NULL): é isso que
 * impede uma organização de fechar o alerta de outra.
 */
function buildHarness({ found = true }: { found?: boolean } = {}) {
  const result = found ? { id: 'alert-1' } : null;

  const repo = {
    findById: jest.fn().mockResolvedValue(result),
    dismiss: jest.fn().mockResolvedValue(result),
    resolve: jest.fn().mockResolvedValue(result),
    markRead: jest.fn().mockResolvedValue(result),
    markAllRead: jest.fn().mockResolvedValue(2),
  } as never;

  const scope = {
    resolveForAccount: jest
      .fn()
      .mockResolvedValue({ accountId: 'acc-1', organizationId: 'org-1' }),
  } as never;

  return {
    getAlert: new GetAlertUseCase(repo, scope),
    dismiss: new DismissAlertUseCase(repo, scope),
    resolve: new ResolveAlertUseCase(repo, scope),
    markRead: new MarkAlertReadUseCase(repo, scope),
    markAllRead: new MarkAllAlertsReadUseCase(repo, scope),
    repo: repo as unknown as Record<string, jest.Mock>,
    scope: scope as unknown as { resolveForAccount: jest.Mock },
  };
}

describe('alert lifecycle use cases', () => {
  it('getAlert reads on the resolved organization, not the raw caller id', async () => {
    const h = buildHarness();

    await h.getAlert.execute('caller-id', 'alert-1');

    expect(h.scope.resolveForAccount).toHaveBeenCalledWith('caller-id');
    expect(h.repo.findById).toHaveBeenCalledWith('alert-1', 'org-1');
  });

  it('getAlert reports NotFound for an alert outside the organization', async () => {
    const h = buildHarness({ found: false });

    await expect(
      h.getAlert.execute('acc-1', 'someone-elses-alert'),
    ).rejects.toThrow(NotFoundException);
  });

  it.each(['dismiss', 'resolve', 'markRead'] as const)(
    '%s acts on the resolved organization, not the raw caller id',
    async (name) => {
      const h = buildHarness();

      await (
        h[name] as { execute: (a: string, b: string) => Promise<unknown> }
      ).execute('caller-id', 'alert-1');

      expect(h.scope.resolveForAccount).toHaveBeenCalledWith('caller-id');
      // O repositório é chamado com a organização *resolvida*, nunca com o id
      // de quem pediu.
      expect(h.repo[name]).toHaveBeenCalledWith('alert-1', 'org-1');
    },
  );

  it.each(['dismiss', 'resolve', 'markRead'] as const)(
    '%s reports NotFound for an alert outside the organization',
    async (name) => {
      const h = buildHarness({ found: false });

      await expect(
        (
          h[name] as { execute: (a: string, b: string) => Promise<unknown> }
        ).execute('acc-1', 'someone-elses-alert'),
      ).rejects.toThrow(NotFoundException);
    },
  );

  it('marks every alert read within the resolved organization', async () => {
    const h = buildHarness();

    await expect(h.markAllRead.execute('acc-1')).resolves.toEqual({
      marked: 2,
    });
    expect(h.repo.markAllRead).toHaveBeenCalledWith('org-1');
  });

  /**
   * Workspace pessoal não tem alerta: a coluna é NOT NULL. Devolver 404 (e não
   * 403) é deliberado — do ponto de vista de quem pede, o alerta realmente não
   * existe naquele escopo, e a alternativa vazaria que ele existe em outro.
   */
  it('reports NotFound when the caller has no organization', async () => {
    const h = buildHarness();
    h.scope.resolveForAccount.mockResolvedValue({
      accountId: 'acc-1',
      organizationId: null,
    });

    await expect(h.dismiss.execute('acc-1', 'alert-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(h.repo.dismiss).not.toHaveBeenCalled();
  });
});
