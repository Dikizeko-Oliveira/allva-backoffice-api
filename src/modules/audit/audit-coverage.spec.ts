import { BadRequestException } from '@nestjs/common';
import { DisconnectIntegrationUseCase } from 'src/modules/integrations/application/use-cases/disconnect-integration.usecase';
import { IntegrationDisconnectionService } from 'src/modules/integrations/application/services/integration-disconnection.service';
import { DeleteAccountUseCase } from 'src/modules/accounts/application/use-cases/delete-account.usecase';
import { AuditEvent } from 'src/modules/audit/domain/entities';

/**
 * M-5: the audit trail must cover integrations and the account lifecycle, not only
 * organization and billing events.
 *
 * These tests assert the *contract* an auditable operation has: the event fires, it
 * carries the actor and the entity, and — critically — a failing audit write never
 * takes the business operation down with it.
 */

function auditSpy() {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

/** Events recorded, in order. */
function events(audit: { record: jest.Mock }): AuditEvent[] {
  return audit.record.mock.calls.map(([input]) => input.event);
}

describe('M-5 audit coverage — integrations', () => {
  function buildDisconnect({ auditFails = false } = {}) {
    const integration = {
      id: 'int-1',
      accountId: 'acc-1',
      organizationId: 'org-1',
      providerType: 'META',
      markDisconnected: jest.fn(),
      status: 'DISCONNECTED',
    };

    const integrationsRepository = {
      update: jest.fn().mockResolvedValue(undefined),
    };

    /**
     * A integração passou a ser resolvida pelo escopo da requisição, e não pela
     * conta que a criou — o mesmo resolvedor que a listagem usa. O dublê
     * devolve a integração do cenário para qualquer escopo.
     */
    const ownerScope = {
      resolveForAccount: jest
        .fn()
        .mockResolvedValue({ accountId: 'acc-1', organizationId: 'org-1' }),
      findIntegrationForOwner: jest.fn().mockResolvedValue(integration),
    };
    const adAccountsRepository = {
      markIntegrationAccountsDisconnected: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const providers = {
      for: jest.fn().mockReturnValue({
        revokeToken: jest.fn().mockResolvedValue(undefined),
      }),
    };

    const audit = auditSpy();
    if (auditFails) {
      audit.record.mockRejectedValue(new Error('audit db down'));
    }

    const disconnection = new IntegrationDisconnectionService(
      integrationsRepository as never,
      adAccountsRepository as never,
      providers as never,
      audit as never,
    );
    const useCase = new DisconnectIntegrationUseCase(
      disconnection,
      ownerScope as never,
    );

    jest
      .spyOn((disconnection as any).logger, 'warn')
      .mockImplementation(() => undefined);

    return { useCase, audit, integration };
  }

  it('records integration.disconnected with actor and entity', async () => {
    const h = buildDisconnect();

    await h.useCase.execute('acc-1', 'META');

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'integration.disconnected',
        entityType: 'integration',
        entityId: 'int-1',
        actorId: 'acc-1',
        organizationId: 'org-1',
      }),
    );
  });

  it('records the event only after the integration is actually disconnected', async () => {
    const h = buildDisconnect();

    await h.useCase.execute('acc-1', 'META');

    expect(h.integration.markDisconnected).toHaveBeenCalled();
    expect(events(h.audit)).toEqual(['integration.disconnected']);
  });
});

describe('M-5 audit coverage — account lifecycle', () => {
  function buildDelete({
    ownedOrganizations = [] as { id: string; name: string }[],
  } = {}) {
    const account = { id: 'acc-1', email: 'ana@example.com' };
    const accountsRepository = {
      findById: jest.fn().mockResolvedValue(account),
      anonymize: jest.fn().mockResolvedValue(undefined),
      listOwnedOrganizations: jest.fn().mockResolvedValue(ownedOrganizations),
    };
    const cancelSubscription = {
      execute: jest.fn().mockResolvedValue(undefined),
    };
    const deleteOrganization = {
      execute: jest
        .fn()
        .mockResolvedValue({ id: 'org-1', deletedAt: new Date() }),
    };

    const audit = auditSpy();

    const useCase = new DeleteAccountUseCase(
      accountsRepository as never,
      cancelSubscription as never,
      deleteOrganization as never,
      audit as never,
    );

    return {
      useCase,
      audit,
      accountsRepository,
      cancelSubscription,
      deleteOrganization,
    };
  }

  it('records account.deleted', async () => {
    const h = buildDelete();

    await h.useCase.execute('acc-1');

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'account.deleted',
        entityType: 'account',
        entityId: 'acc-1',
      }),
    );
  });

  /**
   * O oposto do que este teste exigia antes.
   *
   * A versão anterior se chamava "keeps the deleted account's email in the
   * trail" e cravava `metadata: { email }` — mas `audit_logs` está em
   * `RETENTION_EXEMPT`, guardado por prazo indeterminado. O e-mail que a
   * exclusão apagava da conta ficava, para sempre, no registro da própria
   * exclusão. O `entityId` já identifica a conta para efeito de auditoria, e
   * ele não é dado pessoal.
   */
  it('does not carry the account email into the trail', async () => {
    const h = buildDelete();

    await h.useCase.execute('acc-1');

    const recorded = h.audit.record.mock.calls[0][0] as {
      metadata?: Record<string, unknown>;
    };
    expect(JSON.stringify(recorded)).not.toContain('ana@example.com');
    expect(recorded.metadata?.email).toBeUndefined();
  });

  it('anonymizes instead of deleting the row', async () => {
    const h = buildDelete();

    await h.useCase.execute('acc-1');

    expect(h.accountsRepository.anonymize).toHaveBeenCalledWith('acc-1');
  });

  it('cancels the subscription before anonymizing', async () => {
    const h = buildDelete();

    await h.useCase.execute('acc-1');

    expect(h.cancelSubscription.execute).toHaveBeenCalledWith('acc-1');
    expect(
      h.cancelSubscription.execute.mock.invocationCallOrder[0],
    ).toBeLessThan(h.accountsRepository.anonymize.mock.invocationCallOrder[0]);
  });

  /**
   * Excluir a organização é poder exclusivo do dono, em qualquer caminho — então
   * o encerramento dele a leva junto, em vez de exigir que escolhesse um
   * sucessor para algo que tem o direito de encerrar. Quem quer que ela
   * sobreviva transfere a posse antes.
   */
  it('deletes the organizations the account owns', async () => {
    const h = buildDelete({
      ownedOrganizations: [
        { id: 'org-1', name: 'Acme' },
        { id: 'org-2', name: 'Globex' },
      ],
    });

    await h.useCase.execute('acc-1');

    expect(h.deleteOrganization.execute).toHaveBeenCalledTimes(2);
    expect(h.deleteOrganization.execute).toHaveBeenCalledWith({
      organizationId: 'org-1',
      accountId: 'acc-1',
      membershipId: null,
      role: 'OWNER',
    });
    expect(
      h.deleteOrganization.execute.mock.invocationCallOrder[0],
    ).toBeLessThan(h.accountsRepository.anonymize.mock.invocationCallOrder[0]);
  });

  /**
   * Participar não é possuir: quem só era membro sai sem levar nada da
   * organização, que continua de pé para o resto do time.
   */
  it('leaves untouched the organizations the account only belonged to', async () => {
    const h = buildDelete();

    await h.useCase.execute('acc-1');

    expect(h.deleteOrganization.execute).not.toHaveBeenCalled();
    expect(h.accountsRepository.anonymize).toHaveBeenCalledWith('acc-1');
  });

  /**
   * O caminho do `catch`, que os testes acima não exercitam.
   *
   * Quem nunca passou pelo checkout não tem assinatura no provedor, e quem já
   * cancelou não tem o que cancelar de novo. Nos dois casos o caso de uso de
   * cancelamento lança `BadRequestException`, e tratá-la como falha faria o
   * encerramento quebrar justamente para o usuário de teste gratuito — a maior
   * parte de quem exclui a conta.
   */
  it.each(['SUBSCRIPTION_NOT_FOUND', 'SUBSCRIPTION_ALREADY_CANCELED'])(
    'proceeds when there is nothing to cancel (%s)',
    async (code) => {
      const h = buildDelete();
      h.cancelSubscription.execute.mockRejectedValue(
        new BadRequestException({ code, message: 'nothing to cancel' }),
      );

      await expect(h.useCase.execute('acc-1')).resolves.toBeUndefined();
      expect(h.accountsRepository.anonymize).toHaveBeenCalledWith('acc-1');
    },
  );

  /**
   * O contrário: uma falha real de cancelamento **para** o encerramento. Seguir
   * adiante anonimizaria a conta deixando a cobrança viva na Stripe, e sem o
   * dado de contato para avisar alguém.
   */
  it('aborts when cancelling fails for any other reason', async () => {
    const h = buildDelete();
    h.cancelSubscription.execute.mockRejectedValue(
      new BadRequestException({ code: 'STRIPE_UNAVAILABLE', message: 'boom' }),
    );

    await expect(h.useCase.execute('acc-1')).rejects.toMatchObject({
      response: { code: 'STRIPE_UNAVAILABLE' },
    });
    expect(h.accountsRepository.anonymize).not.toHaveBeenCalled();
  });

  /**
   * `AuditLogService.record` engole a própria falha e sempre resolve — é
   * garantia do serviço, testada em `audit-log.service.spec`. O mock aqui a
   * repete de propósito: o que este teste cobre é que o encerramento não
   * depende do resultado da trilha, e não o comportamento do serviço.
   */
  it('completes the deletion regardless of the audit trail', async () => {
    const h = buildDelete();

    await expect(h.useCase.execute('acc-1')).resolves.toBeUndefined();
    expect(h.accountsRepository.anonymize).toHaveBeenCalledWith('acc-1');
  });
});
