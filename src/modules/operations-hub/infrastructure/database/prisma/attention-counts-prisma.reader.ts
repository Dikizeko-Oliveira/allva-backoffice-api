import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import {
  isAttentionSeverity,
  SupportAttentionKey,
} from 'src/modules/operations-hub/domain/attention-signals';
import {
  AttentionCountsReaderInterface,
  UnacknowledgedAlertCount,
} from 'src/modules/operations-hub/domain/ports';
import {
  LIVE_TICKET_STATUSES,
  SLA_AT_RISK_WINDOW_MS,
} from 'src/modules/support/domain/sla';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * As contagens do hub, uma consulta por sinal.
 *
 * ## Uma falha não apaga o hub
 *
 * Cada contagem roda isolada. Se uma cair, ela **some da resposta** e o resto
 * segue — o use case a devolve como `count: null`. O hub é a porta de entrada
 * do backoffice, e o dia em que uma tabela dá problema é justamente o dia em
 * que a tela não pode estar em branco.
 *
 * As regras de "estourado" e "em risco" são as mesmas de
 * `TicketSlaSnapshot.slaView`: só prazos pendentes contam, e estourado vence em
 * risco — um chamado não aparece nos dois contadores.
 */
@Injectable()
export class AttentionCountsPrismaReader implements AttentionCountsReaderInterface {
  private readonly logger = new Logger(AttentionCountsPrismaReader.name);

  constructor(private readonly prisma: PrismaService) {}

  async countSupport(
    keys: readonly SupportAttentionKey[],
    operatorId: string,
    now: Date,
  ): Promise<Partial<Record<SupportAttentionKey, number>>> {
    const settled = await Promise.allSettled(
      keys.map(
        async (key) =>
          [key, await this.countOne(key, operatorId, now)] as const,
      ),
    );

    const counts: Partial<Record<SupportAttentionKey, number>> = {};

    settled.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        counts[result.value[0]] = result.value[1];
        return;
      }

      this.logger.warn(
        `Attention signal "${keys[index]}" unavailable: ${describe(result.reason)}`,
      );
    });

    return counts;
  }

  async countUnacknowledgedAlerts(
    permissions: readonly string[],
  ): Promise<UnacknowledgedAlertCount[]> {
    if (permissions.length === 0) return [];

    try {
      const groups = await this.prisma.alertEvent.groupBy({
        by: ['ruleId', 'severity'],
        where: {
          acknowledgedAt: null,
          rule: { requiredPermission: { in: [...permissions] } },
        },
        _count: { _all: true },
      });

      if (groups.length === 0) return [];

      const rules = await this.prisma.alertRule.findMany({
        where: { id: { in: groups.map((group) => group.ruleId) } },
        select: { id: true, requiredPermission: true },
      });
      const permissionOf = new Map(
        rules.map((rule) => [rule.id, rule.requiredPermission]),
      );

      const totals = new Map<string, UnacknowledgedAlertCount>();

      for (const group of groups) {
        const permission = permissionOf.get(group.ruleId);
        if (!permission || !isAttentionSeverity(group.severity)) continue;

        const key = `${permission}|${group.severity}`;
        const current = totals.get(key) ?? {
          permission,
          severity: group.severity,
          count: 0,
        };
        current.count += group._count._all;
        totals.set(key, current);
      }

      return [...totals.values()];
    } catch (error) {
      this.logger.warn(
        `Attention signal "alerts.unacknowledged" unavailable: ${describe(error)}`,
      );
      return [];
    }
  }

  private countOne(
    key: SupportAttentionKey,
    operatorId: string,
    now: Date,
  ): Promise<number> {
    const live: Prisma.TicketSlaSnapshotWhereInput = {
      status: { in: [...LIVE_TICKET_STATUSES] },
    };
    const breached = breachedAt(now);

    switch (key) {
      case 'support.sla_breached':
        return this.prisma.ticketSlaSnapshot.count({
          where: { ...live, ...breached },
        });

      case 'support.sla_at_risk': {
        const horizon = new Date(now.getTime() + SLA_AT_RISK_WINDOW_MS);
        return this.prisma.ticketSlaSnapshot.count({
          where: {
            ...live,
            NOT: breached,
            OR: [
              {
                firstOperatorReplyAt: null,
                dueFirstResponseAt: { gte: now, lte: horizon },
              },
              { dueResolutionAt: { gte: now, lte: horizon } },
            ],
          },
        });
      }

      case 'support.escalated':
        return this.prisma.ticketSlaSnapshot.count({
          where: {
            ...live,
            escalatedAt: { not: null },
            escalatedAcknowledgedAt: null,
          },
        });

      /** O cliente falou por último num chamado deste operador. */
      case 'support.assigned_to_me_waiting':
        return this.prisma.ticketSlaSnapshot.count({
          where: {
            ...live,
            assigneeId: operatorId,
            lastMessageKind: 'CUSTOMER',
          },
        });
    }
  }
}

/** Algum prazo pendente já venceu. */
function breachedAt(now: Date): Prisma.TicketSlaSnapshotWhereInput {
  return {
    OR: [
      { firstOperatorReplyAt: null, dueFirstResponseAt: { lt: now } },
      { dueResolutionAt: { lt: now } },
    ],
  };
}

function describe(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
