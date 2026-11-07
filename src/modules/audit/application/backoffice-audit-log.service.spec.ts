import { Operator } from 'src/modules/auth/domain/entities';
import type { BackofficeAuditLog } from 'src/modules/audit/domain/entities';
import type { BackofficeAuditLogsRepositoryInterface } from 'src/modules/audit/domain/ports';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { BackofficeAuditLogService } from './backoffice-audit-log.service';

const actor = Operator.restore({
  id: 'op-1',
  name: 'Ana',
  email: 'ana@allva.com',
  platformRole: 'ALLVA_SUPPORT',
  permissions: ['support:manage'],
  accessToken: 'token',
});

function build() {
  const saved: BackofficeAuditLog[] = [];
  const repository = {
    save: jest.fn(async (log: BackofficeAuditLog) => {
      saved.push(log);
    }),
    list: jest.fn(),
  } as unknown as BackofficeAuditLogsRepositoryInterface;
  const requestContext = new RequestContextService();

  return {
    saved,
    requestContext,
    service: new BackofficeAuditLogService(repository, requestContext),
  };
}

const entry = {
  actor,
  action: 'support.ticket.assigned',
  subjectType: 'SUPPORT_TICKET',
  subjectId: 'ticket-1',
} as const;

/** GAP-046: toda escrita vinda de requisição HTTP grava a origem. */
describe('BackofficeAuditLogService', () => {
  it('preenche ip e userAgent a partir do contexto da requisição', async () => {
    const { service, saved, requestContext } = build();

    await requestContext.run(
      {
        correlationId: 'c-1',
        clientIp: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
      },
      () => service.record(entry),
    );

    expect(saved[0].ip).toBe('203.0.113.7');
    expect(saved[0].userAgent).toBe('Mozilla/5.0');
  });

  it('a origem passada explicitamente vence o contexto', async () => {
    const { service, saved, requestContext } = build();

    await requestContext.run(
      { clientIp: '203.0.113.7', userAgent: 'ctx' },
      () =>
        service.record({ ...entry, ip: '198.51.100.1', userAgent: 'explicit' }),
    );

    expect(saved[0].ip).toBe('198.51.100.1');
    expect(saved[0].userAgent).toBe('explicit');
  });

  it('fora de uma requisição a origem fica vazia', async () => {
    const { service, saved } = build();

    await service.record(entry);

    expect(saved[0].ip).toBeNull();
    expect(saved[0].userAgent).toBeNull();
  });
});
