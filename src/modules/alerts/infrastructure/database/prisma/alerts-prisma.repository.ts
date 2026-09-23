import { Injectable } from '@nestjs/common';
import {
  AlertDTO,
  AlertListQuery,
  AlertState,
  AlertSubject,
  AlertUpsertResult,
  AlertsRepositoryInterface,
  CreateAlertInput,
} from 'src/modules/alerts/domain/ports/alerts.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

const PAGE_SIZE = 20;

type AlertRecord = {
  id: string;
  organizationId: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  adId: string | null;
  adAccountId: string | null;
  wasteItemId: string | null;
  recommendationId: string | null;
  actionExecutionId: string | null;
  integrationId: string | null;
  readAt: Date | null;
  dismissedAt: Date | null;
  resolvedAt: Date | null;
  notifiedAt: Date | null;
  occurrences: number;
  firstOccurredAt: Date;
  lastOccurredAt: Date;
  createdAt: Date;
};

/** As seis colunas de sujeito, na forma que o banco espera. */
function subjectColumns(subject: AlertSubject) {
  const empty = {
    adId: null as string | null,
    adAccountId: null as string | null,
    wasteItemId: null as string | null,
    recommendationId: null as string | null,
    actionExecutionId: null as string | null,
    integrationId: null as string | null,
  };

  switch (subject.kind) {
    case 'AD':
      return { ...empty, adId: subject.adId };
    case 'AD_ACCOUNT':
      return { ...empty, adAccountId: subject.adAccountId };
    case 'WASTE_ITEM':
      return { ...empty, wasteItemId: subject.wasteItemId };
    case 'RECOMMENDATION':
      return { ...empty, recommendationId: subject.recommendationId };
    case 'ACTION_EXECUTION':
      return { ...empty, actionExecutionId: subject.actionExecutionId };
    case 'INTEGRATION':
      return { ...empty, integrationId: subject.integrationId };
  }
}

/**
 * Reconstitui o sujeito a partir da coluna preenchida. O `CHECK` de
 * exclusividade garante que há exatamente uma — o `null` no fim é inalcançável
 * enquanto a constraint existir, e existe para o caso de alguém a remover.
 */
function readSubject(record: AlertRecord): AlertSubject | null {
  if (record.adId) return { kind: 'AD', adId: record.adId };
  if (record.adAccountId)
    return { kind: 'AD_ACCOUNT', adAccountId: record.adAccountId };
  if (record.wasteItemId)
    return { kind: 'WASTE_ITEM', wasteItemId: record.wasteItemId };
  if (record.recommendationId)
    return {
      kind: 'RECOMMENDATION',
      recommendationId: record.recommendationId,
    };
  if (record.actionExecutionId)
    return {
      kind: 'ACTION_EXECUTION',
      actionExecutionId: record.actionExecutionId,
    };
  if (record.integrationId)
    return { kind: 'INTEGRATION', integrationId: record.integrationId };
  return null;
}

function toDTO(record: AlertRecord): AlertDTO {
  const subject = readSubject(record);
  if (!subject) {
    // Só acontece se o CHECK `alerts_one_subject` for removido do banco. Falhar
    // aqui é melhor que devolver um alerta órfão — que é exatamente o bug do v1.
    throw new Error(
      `Alerta ${record.id} não declara sujeito. O CHECK alerts_one_subject deveria impedir isso.`,
    );
  }

  return {
    id: record.id,
    organizationId: record.organizationId,
    type: record.type as AlertDTO['type'],
    severity: record.severity as AlertDTO['severity'],
    title: record.title,
    message: record.message,
    subject,
    isRead: record.readAt !== null,
    readAt: record.readAt,
    dismissedAt: record.dismissedAt,
    resolvedAt: record.resolvedAt,
    notifiedAt: record.notifiedAt,
    occurrences: record.occurrences,
    firstOccurredAt: record.firstOccurredAt,
    lastOccurredAt: record.lastOccurredAt,
    createdAt: record.createdAt,
  };
}

/** Translates the lifecycle filter into a Prisma `where` fragment. */
function stateFilter(state: AlertState | undefined) {
  switch (state ?? 'OPEN') {
    case 'OPEN':
      return { dismissedAt: null, resolvedAt: null };
    case 'DISMISSED':
      return { dismissedAt: { not: null } };
    case 'RESOLVED':
      return { resolvedAt: { not: null } };
    case 'ALL':
      return {};
  }
}

@Injectable()
export class AlertsPrismaRepository implements AlertsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async createOrRecur(
    input: CreateAlertInput & { fingerprint: string },
  ): Promise<AlertUpsertResult> {
    // Só alerta *aberto* deduplica. Depois de resolvido, a mesma condição
    // reaparecendo é informação nova e merece alerta próprio — e é por isso que
    // o índice único é parcial (`WHERE resolved_at IS NULL`) e não total.
    const existing = (await this.prisma.alert.findFirst({
      where: {
        organizationId: input.organizationId,
        fingerprint: input.fingerprint,
        dismissedAt: null,
        resolvedAt: null,
      },
      orderBy: { createdAt: 'desc' },
    })) as AlertRecord | null;

    if (existing) {
      const updated = (await this.prisma.alert.update({
        where: { id: existing.id },
        data: {
          occurrences: { increment: 1 },
          // Recorrência escreve `lastOccurredAt`, nunca `updatedAt`: o segundo é
          // técnico e bumparia ao marcar como lido (⊕13).
          lastOccurredAt: new Date(),
          // O texto da última execução vence: o diagnóstico pode ter afinado e a
          // severidade pode ter escalado desde a primeira ocorrência.
          severity: input.severity,
          message: input.message,
          title: input.title,
        },
      })) as AlertRecord;

      return { alert: toDTO(updated), created: false };
    }

    const record = (await this.prisma.alert.create({
      data: {
        organizationId: input.organizationId,
        type: input.type,
        severity: input.severity,
        title: input.title,
        message: input.message,
        fingerprint: input.fingerprint,
        correlationId: input.correlationId ?? null,
        metadata: (input.metadata ?? undefined) as never,
        ...subjectColumns(input.subject),
      },
    })) as AlertRecord;

    return { alert: toDTO(record), created: true };
  }

  async list(
    query: AlertListQuery,
  ): Promise<{ data: AlertDTO[]; total: number }> {
    const page = Math.max(1, query.page ?? 1);
    const limit = query.limit ?? PAGE_SIZE;
    const skip = (page - 1) * limit;

    const where = {
      organizationId: query.organizationId,
      ...(query.isRead === undefined
        ? {}
        : query.isRead
          ? { readAt: { not: null } }
          : { readAt: null }),
      ...(query.severity ? { severity: query.severity } : {}),
      ...stateFilter(query.state),
    };

    const [data, total] = await Promise.all([
      this.prisma.alert.findMany({
        where,
        // Severity first, then newest — M-2 "priorizacao": a CRITICAL alert must not
        // sit below a newer INFO one. Postgres orders enums by declaration order
        // (INFO, WARNING, CRITICAL), so `desc` yields CRITICAL -> WARNING -> INFO.
        orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.alert.count({ where }),
    ]);

    return { data: (data as AlertRecord[]).map(toDTO), total };
  }

  async findById(id: string, organizationId: string): Promise<AlertDTO | null> {
    const record = (await this.prisma.alert.findFirst({
      where: { id, organizationId },
    })) as AlertRecord | null;
    return record ? toDTO(record) : null;
  }

  async markRead(id: string, organizationId: string): Promise<AlertDTO | null> {
    const record = (await this.prisma.alert.findFirst({
      where: { id, organizationId },
    })) as AlertRecord | null;
    if (!record) return null;

    const updated = (await this.prisma.alert.update({
      where: { id },
      data: { readAt: record.readAt ?? new Date() },
    })) as AlertRecord;
    return toDTO(updated);
  }

  async markAllRead(organizationId: string): Promise<number> {
    const result = await this.prisma.alert.updateMany({
      where: { organizationId, readAt: null },
      data: { readAt: new Date() },
    });
    return result.count;
  }

  async dismiss(id: string, organizationId: string): Promise<AlertDTO | null> {
    return this.closeAlert(id, organizationId, 'dismissedAt');
  }

  async resolve(id: string, organizationId: string): Promise<AlertDTO | null> {
    return this.closeAlert(id, organizationId, 'resolvedAt');
  }

  /**
   * Shared body of dismiss/resolve. Idempotent: an alert already carrying the
   * timestamp is returned untouched, so the first close is the one that counts.
   */
  private async closeAlert(
    id: string,
    organizationId: string,
    field: 'dismissedAt' | 'resolvedAt',
  ): Promise<AlertDTO | null> {
    const record = (await this.prisma.alert.findFirst({
      where: { id, organizationId },
    })) as AlertRecord | null;

    if (!record) return null;
    if (record[field]) return toDTO(record);

    const updated = (await this.prisma.alert.update({
      where: { id },
      // Closing an alert also marks it read: it left the user's queue either way.
      data: {
        [field]: new Date(),
        ...(record.readAt ? {} : { readAt: new Date() }),
      },
    })) as AlertRecord;

    return toDTO(updated);
  }

  async markNotified(id: string, at: Date): Promise<void> {
    await this.prisma.alert.update({
      where: { id },
      data: { notifiedAt: at },
    });
  }
}
