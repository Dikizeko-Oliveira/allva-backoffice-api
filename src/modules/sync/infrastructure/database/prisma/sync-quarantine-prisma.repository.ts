import { Injectable } from '@nestjs/common';
import type {
  QuarantineReason,
  QuarantineResolution,
} from 'src/modules/sync/domain/quarantine';
import {
  QuarantineListQuery,
  QuarantineRecord,
  SyncQuarantineRepositoryInterface,
} from 'src/modules/sync/domain/ports/sync-quarantine.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';
import {
  decodeCursor,
  encodeCursor,
} from 'src/shared/infrastructure/http/pagination/cursor';

/** Ordenação única da quarentena; viaja no cursor para que trocar de ordem o invalide. */
const QUARANTINE_SORT = 'firstSeenAt:asc';

@Injectable()
export class SyncQuarantinePrismaRepository extends SyncQuarantineRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Registra ou recorre.
   *
   * A unique parcial `sync_quarantine_open_unique` (`WHERE resolved_at IS NULL`)
   * é o que faz a recorrência ser recorrência: sem ela, cada ingest criaria uma
   * linha nova e `attempts` — que é o sinal de "isto não vai resolver sozinho" —
   * nunca passaria de 1.
   */
  async record(input: {
    organizationId: string;
    adAccountId: string;
    externalAdId: string;
    reason: QuarantineReason;
    payload: Record<string, unknown> | null;
    now: Date;
  }): Promise<void> {
    const open = await this.prisma.syncQuarantine.findFirst({
      where: {
        adAccountId: input.adAccountId,
        externalAdId: input.externalAdId,
        resolvedAt: null,
      },
      select: { id: true },
    });

    if (open) {
      await this.prisma.syncQuarantine.update({
        where: { id: open.id },
        data: {
          attempts: { increment: 1 },
          lastSeenAt: input.now,
          reason: input.reason,
        },
      });
      return;
    }

    await this.prisma.syncQuarantine.create({
      data: {
        organizationId: input.organizationId,
        adAccountId: input.adAccountId,
        externalAdId: input.externalAdId,
        reason: input.reason,
        firstSeenAt: input.now,
        lastSeenAt: input.now,
        payload: toPrismaJson(input.payload ?? undefined),
      },
    });
  }

  async listOpen(adAccountId: string): Promise<QuarantineRecord[]> {
    const rows = await this.prisma.syncQuarantine.findMany({
      where: { adAccountId, resolvedAt: null },
      orderBy: { firstSeenAt: 'asc' },
    });

    return rows.map(toDomain);
  }

  async resolve(input: {
    ids: string[];
    resolution: QuarantineResolution;
    at: Date;
  }): Promise<number> {
    if (input.ids.length === 0) return 0;

    const result = await this.prisma.syncQuarantine.updateMany({
      where: { id: { in: input.ids }, resolvedAt: null },
      data: { resolvedAt: input.at, resolvedReason: input.resolution },
    });

    return result.count;
  }

  async list(query: QuarantineListQuery): Promise<{
    items: QuarantineRecord[];
    nextCursor: string | null;
  }> {
    // A ordenação é fixa (`firstSeenAt`, id como desempate): a quarentena é uma
    // fila de investigação, não uma lista rankeável, e o cursor tem de recusar
    // um pedido emitido sob outra ordenação (§7.0.5).
    const cursor = query.cursor
      ? decodeCursor(query.cursor, QUARANTINE_SORT)
      : null;

    const rows = await this.prisma.syncQuarantine.findMany({
      where: {
        organizationId: query.organizationId,
        ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
        resolvedAt: null,
        ...(cursor ? { id: { gt: cursor.id } } : {}),
      },
      orderBy: { id: 'asc' },
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;
    const items = (hasMore ? rows.slice(0, query.limit) : rows).map(toDomain);

    return {
      items,
      nextCursor: hasMore
        ? encodeCursor({
            sort: QUARANTINE_SORT,
            keys: [items[items.length - 1].firstSeenAt.toISOString()],
            id: items[items.length - 1].id,
          })
        : null,
    };
  }
}

function toDomain(row: {
  id: string;
  organizationId: string;
  adAccountId: string;
  externalAdId: string;
  reason: string;
  attempts: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  payload: unknown;
}): QuarantineRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    adAccountId: row.adAccountId,
    externalAdId: row.externalAdId,
    reason: row.reason,
    attempts: row.attempts,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    payload: (row.payload as Record<string, unknown> | null) ?? null,
  };
}
