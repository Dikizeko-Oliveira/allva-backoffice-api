import { Injectable } from '@nestjs/common';
import {
  DailyDigestRepositoryInterface,
  type StoredDigest,
} from 'src/modules/analytics/domain/ports/daily-digest.repository';
import type { DigestFacts } from 'src/modules/analytics/domain/daily-digest';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

type Row = {
  digestDate: Date;
  inputDigest: string;
  facts: unknown;
  narrative: string | null;
  enrichedByAI: boolean;
  promptVersion: string | null;
  reusedFromDate: Date | null;
};

function toDigest(row: Row): StoredDigest {
  return {
    digestDate: row.digestDate,
    inputDigest: row.inputDigest,
    facts: row.facts as DigestFacts,
    narrative: row.narrative,
    enrichedByAI: row.enrichedByAI,
    promptVersion: row.promptVersion,
    reusedFromDate: row.reusedFromDate,
  };
}

@Injectable()
export class DailyDigestPrismaRepository implements DailyDigestRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {}

  async latestFor(organizationId: string): Promise<StoredDigest | null> {
    const row = await this.prisma.organizationDailyDigest.findFirst({
      where: { organizationId },
      orderBy: { digestDate: 'desc' },
    });

    return row ? toDigest(row as unknown as Row) : null;
  }

  async findByDate(input: {
    organizationId: string;
    digestDate: Date;
  }): Promise<StoredDigest | null> {
    const row = await this.prisma.organizationDailyDigest.findUnique({
      where: {
        organizationId_digestDate: {
          organizationId: input.organizationId,
          digestDate: input.digestDate,
        },
      },
    });

    return row ? toDigest(row as unknown as Row) : null;
  }

  async save(input: {
    organizationId: string;
    digestDate: Date;
    inputDigest: string;
    facts: DigestFacts;
    narrative: string | null;
    enrichedByAI: boolean;
    promptVersion: string | null;
    reusedFromDate: Date | null;
  }): Promise<void> {
    const data = {
      inputDigest: input.inputDigest,
      facts: input.facts as never,
      narrative: input.narrative,
      enrichedByAI: input.enrichedByAI,
      promptVersion: input.promptVersion,
      reusedFromDate: input.reusedFromDate,
    };

    // `upsert` sobre a unique `(organizationId, digestDate)`: enfileirar o job
    // duas vezes encontra a linha do dia em vez de criar uma segunda — e cada
    // linha a mais seria uma chamada de LLM a mais.
    await this.prisma.organizationDailyDigest.upsert({
      where: {
        organizationId_digestDate: {
          organizationId: input.organizationId,
          digestDate: input.digestDate,
        },
      },
      create: {
        organizationId: input.organizationId,
        digestDate: input.digestDate,
        ...data,
      },
      update: data,
    });
  }

  async listOrganizationsWithRecentSync(since: Date): Promise<string[]> {
    // Só organizações com ingest completo recente. Sem dado novo o digest sairia
    // idêntico e cairia em `SKIPPED_DIGEST` de qualquer forma — mas nem
    // enfileirar economiza o ciclo inteiro, que é por organização.
    const rows = await this.prisma.adAccount.findMany({
      // `organizationId` é NOT NULL desde A2-S1 (P10): conta de anúncios sem
      // organização não existe mais, então não há o que filtrar aqui.
      where: { lastSuccessfulFullSyncAt: { gte: since } },
      select: { organizationId: true },
      distinct: ['organizationId'],
    });

    return rows.map((row) => row.organizationId);
  }
}
