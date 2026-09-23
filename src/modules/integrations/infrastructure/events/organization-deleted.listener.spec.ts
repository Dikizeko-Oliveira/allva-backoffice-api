import { OrganizationDeletedListener } from './organization-deleted.listener';

/**
 * A organização excluída vira um job de revogação — e nada mais inline.
 *
 * O `jobId` derivado do evento é o que colapsa uma reentrega no mesmo job: a
 * mesma exclusão não pode revogar duas vezes nem registrar a desconexão em
 * dobro na trilha.
 */
describe('exclusão de organização → revogação das credenciais', () => {
  it('enfileira a revogação com o autor e a correlação do evento', async () => {
    const dispatcher = {
      revokeForOrganization: jest.fn(async () => undefined),
    };
    const listener = new OrganizationDeletedListener(dispatcher as never);

    await listener.onOrganizationDeleted({
      eventId: 'evt-1',
      name: 'organization.deleted',
      eventVersion: 1,
      occurredAt: '2026-09-14T12:00:00.000Z',
      organizationId: 'org-1',
      correlationId: 'corr-1',
      causationId: null,
      payload: { actorId: 'acc-1' },
    });

    expect(dispatcher.revokeForOrganization).toHaveBeenCalledWith(
      {
        ctx: { correlationId: 'corr-1', causationId: 'evt-1' },
        organizationId: 'org-1',
        actorId: 'acc-1',
      },
      'organization.deleted:evt-1',
    );
  });
});
