import { BackofficeAuditLogsPrismaRepository } from 'src/modules/audit/infrastructure/database/prisma/backoffice-audit-logs-prisma.repository';
import type { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { connect, truncate } from './support/prisma';

/** Filtros e paginação da trilha — um defeito de filtro já escapou (23/09). */
describe('BackofficeAuditLogsPrismaRepository.list', () => {
  let prisma: PrismaService;
  let repository: BackofficeAuditLogsPrismaRepository;

  beforeAll(async () => {
    prisma = connect();
    repository = new BackofficeAuditLogsPrismaRepository(prisma);
    await truncate(prisma, ['backoffice_audit_logs']);

    const row = (index: number, actorId: string, action: string) => ({
      actorId,
      action,
      subjectType: 'SUPPORT_TICKET',
      subjectId: `ticket-${index % 2}`,
      createdAt: new Date(Date.UTC(2026, 10, 1 + index)),
    });

    await prisma.backofficeAuditLog.createMany({
      data: [
        row(0, 'op-1', 'support.ticket.assigned'),
        row(1, 'op-1', 'internal_note.created'),
        row(2, 'op-2', 'support.ticket.assigned'),
        row(3, 'op-2', 'support.ticket.assigned'),
        row(4, 'op-1', 'support.ticket.assigned'),
      ],
    });
  });
  afterAll(() => prisma.$disconnect());

  const firstPage = { page: 1, pageSize: 2 };

  it('pagina do mais recente para o mais antigo, com o total', async () => {
    const page1 = await repository.list({}, firstPage);
    const page3 = await repository.list({}, { page: 3, pageSize: 2 });

    expect(page1.total).toBe(5);
    expect(page1.items.map((log) => log.createdAt.getUTCDate())).toEqual([
      5, 4,
    ]);
    expect(page3.items).toHaveLength(1);
  });

  it('filtra por operador e ação juntos', async () => {
    const result = await repository.list(
      { actorId: 'op-1', action: 'support.ticket.assigned' },
      { page: 1, pageSize: 20 },
    );

    expect(result.total).toBe(2);
  });

  it('filtra pelo assunto', async () => {
    expect(
      (await repository.list({ subjectId: 'ticket-1' }, firstPage)).total,
    ).toBe(2);
  });

  it('janela de datas inclusiva nas duas pontas', async () => {
    const result = await repository.list(
      {
        from: new Date(Date.UTC(2026, 10, 2)),
        to: new Date(Date.UTC(2026, 10, 4)),
      },
      { page: 1, pageSize: 20 },
    );

    expect(result.total).toBe(3);
  });
});
