import { Injectable } from '@nestjs/common';
import {
  CloseSyncOperationInput,
  OpenSyncOperation,
  OpenSyncOperationInput,
  SyncKind,
  SyncOperationsRepositoryInterface,
} from 'src/modules/sync/domain/ports/sync-operations.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';

@Injectable()
export class SyncOperationsPrismaRepository extends SyncOperationsRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async open(input: OpenSyncOperationInput): Promise<OpenSyncOperation> {
    const startedAt = new Date();

    const row = await this.prisma.syncOperation.create({
      data: {
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        adAccountId: input.adAccountId ?? null,
        adId: input.adId ?? null,
        direction: input.direction,
        kind: input.kind,
        trigger: input.trigger,
        status: 'RUNNING',
        windowStart: input.windowStart ?? null,
        windowEnd: input.windowEnd ?? null,
        restatementWindowDays: input.restatementWindowDays ?? null,
        startedAt,
      },
      select: { id: true, startedAt: true },
    });

    // `startedAt` volta porque a guarda de recência o usa como **limite inferior
    // seguro** quando a plataforma não expõe o instante do dado (§8.4.1, B4): o
    // dado não pode ser mais novo que o momento em que a leitura começou.
    return { id: row.id, startedAt: row.startedAt ?? startedAt };
  }

  async saveCheckpoint(
    syncOperationId: string,
    checkpoints: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.syncOperation.update({
      where: { id: syncOperationId },
      data: { checkpoints: toPrismaJson(checkpoints) },
    });
  }

  async close(
    syncOperationId: string,
    input: CloseSyncOperationInput,
  ): Promise<void> {
    await this.prisma.syncOperation.update({
      where: { id: syncOperationId },
      data: {
        status: input.status,
        entitiesRead: input.entitiesRead,
        entitiesWritten: input.entitiesWritten,
        driftsDetected: input.driftsDetected ?? 0,
        wasComplete: input.wasComplete,
        stepResults: toPrismaJson({ steps: input.stepResults }),
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        finishedAt: new Date(),
      },
    });
  }

  async lastCheckpoint(input: {
    adAccountId: string;
    kind: SyncKind;
  }): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.syncOperation.findFirst({
      where: {
        adAccountId: input.adAccountId,
        kind: input.kind,
        // Só interessa retomar o que **não** terminou: um checkpoint de operação
        // concluída descreveria a última página lida, e recomeçar dali pularia
        // tudo que veio antes na janela seguinte.
        status: { in: ['RUNNING', 'PARTIAL', 'FAILED'] },
      },
      orderBy: { startedAt: 'desc' },
      select: { checkpoints: true },
    });

    return (row?.checkpoints as Record<string, unknown> | null) ?? null;
  }
}
