import { AlertRuleEvaluatorService } from 'src/modules/alerts/application/services/alert-rule-evaluator.service';
import { AlertRule } from 'src/modules/alerts/domain/entities';
import { AlertEventsPrismaRepository } from 'src/modules/alerts/infrastructure/database/prisma/alert-events-prisma.repository';
import { AlertRulesPrismaRepository } from 'src/modules/alerts/infrastructure/database/prisma/alert-rules-prisma.repository';
import { AttentionCountsPrismaReader } from 'src/modules/operations-hub/infrastructure/database/prisma/attention-counts-prisma.reader';
import { TicketSlaSnapshot } from 'src/modules/support/domain/entities';
import { TicketSlaSnapshotsPrismaRepository } from 'src/modules/support/infrastructure/database/prisma/ticket-sla-snapshots-prisma.repository';
import type { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { connect, truncate } from './support/prisma';

const MINUTE = 60_000;

/**
 * GAP-044 + GAP-059 contra o banco: as contagens do hub com a janela de risco
 * proporcional, e a regra ativa que vira um evento visível, uma vez.
 */
describe('alertas sobre os sinais de atendimento', () => {
  let prisma: PrismaService;
  const now = new Date('2026-11-06T12:00:00Z');

  beforeAll(() => {
    prisma = connect();
  });
  beforeEach(() =>
    truncate(prisma, ['alert_events', 'alert_rules', 'ticket_sla_snapshots']),
  );
  afterAll(() => prisma.$disconnect());

  /** Um chamado vivo, aberto há `ageMinutes`, com as metas dadas. */
  async function openTicket(
    id: string,
    ageMinutes: number,
    targets: { firstResponseMinutes: number; resolutionMinutes: number },
  ) {
    const openedAt = new Date(now.getTime() - ageMinutes * MINUTE);
    const snapshot = TicketSlaSnapshot.open(
      {
        id,
        status: 'OPEN',
        priority: 'HIGH',
        category: null,
        assigneeId: null,
        createdAt: openedAt,
        lastMessageAt: openedAt,
        resolvedAt: null,
        messages: [{ kind: 'CUSTOMER', createdAt: openedAt }],
      },
      targets,
    );
    await new TicketSlaSnapshotsPrismaRepository(prisma).saveMany([snapshot]);
  }

  const HIGH = { firstResponseMinutes: 120, resolutionMinutes: 24 * 60 };

  it('HIGH recém-aberto não conta como em risco; perto do prazo, conta', async () => {
    await openTicket('fresh', 1, HIGH);
    await openTicket('near', 100, HIGH); // vence em 20 min; janela de 30
    await openTicket('late', 130, HIGH); // venceu há 10 min

    const counts = await new AttentionCountsPrismaReader(prisma).countSupport(
      ['support.sla_breached', 'support.sla_at_risk'],
      '',
      now,
    );

    expect(counts).toEqual({
      'support.sla_breached': 1,
      'support.sla_at_risk': 1,
    });
  });

  it('regra ativa gera um evento, e segura enquanto ele está aberto', async () => {
    await openTicket('late', 130, HIGH);
    const rule = AlertRule.create({
      source: 'support.sla_breached',
      threshold: '>= 1',
      channel: 'EMAIL',
      target: 'suporte@allva.com',
      requiredPermission: 'support:read',
    });
    await new AlertRulesPrismaRepository(prisma).save(rule);

    const events = new AlertEventsPrismaRepository(prisma);
    const evaluator = new AlertRuleEvaluatorService(
      new AlertRulesPrismaRepository(prisma),
      events,
      new AttentionCountsPrismaReader(prisma),
    );

    expect((await evaluator.evaluate(now)).FIRE).toBe(1);
    expect((await evaluator.evaluate(now)).HOLD_OPEN_EVENT).toBe(1);

    const listed = await events.list(
      { permissions: ['support:read'], acknowledged: false },
      { page: 1, pageSize: 20 },
    );
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      ruleId: rule.id,
      severity: 'CRITICAL',
      requiredPermission: 'support:read',
    });
  });
});
