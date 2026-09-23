import { Injectable } from '@nestjs/common';
import {
  AiDecisionLogRepositoryInterface,
  AiDecisionRecord,
} from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { toPrismaJson } from 'src/shared/infrastructure/database/prisma/json';

@Injectable()
export class AiDecisionLogPrismaRepository extends AiDecisionLogRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async record(entry: AiDecisionRecord): Promise<void> {
    await this.prisma.aIDecisionLog.create({
      data: {
        organizationId: entry.organizationId,
        adId: entry.adId ?? null,
        creativeUploadId: entry.creativeUploadId ?? null,
        recommendationId: entry.recommendationId ?? null,
        taskType: entry.taskType,
        provider: entry.provider,
        model: entry.model,
        promptVersion: entry.promptVersion,
        outcome: entry.outcome,
        fallbackUsed: entry.fallbackUsed,
        inputTokens: entry.inputTokens ?? null,
        outputTokens: entry.outputTokens ?? null,
        latencyMs: entry.latencyMs ?? null,
        costBase: entry.costBase ?? null,
        usdToBaseRate: entry.usdToBaseRate ?? null,
        inputDigest: entry.inputDigest ?? null,
        promptHash: entry.promptHash,
        responseText: entry.responseText ?? null,
        errorPayload: toPrismaJson(entry.errorPayload ?? undefined),
        correlationId: entry.correlationId ?? null,
      },
    });
  }

  /**
   * Só o que de fato foi gasto.
   *
   * `SKIPPED_BUDGET` e `SKIPPED_DIGEST` ficam de fora: somá-los faria o teto se
   * esgotar com **economia**, que é o oposto do que ele mede — e a organização
   * perderia o enriquecimento justamente por ter economizado bem.
   */
  async spentTodayBase(input: {
    organizationId: string;
    day: Date;
  }): Promise<number> {
    const start = new Date(
      Date.UTC(
        input.day.getUTCFullYear(),
        input.day.getUTCMonth(),
        input.day.getUTCDate(),
      ),
    );
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);

    const aggregate = await this.prisma.aIDecisionLog.aggregate({
      where: {
        organizationId: input.organizationId,
        createdAt: { gte: start, lt: end },
        outcome: { in: ['SUCCEEDED', 'FAILED'] },
      },
      _sum: { costBase: true },
    });

    // Chamada que falhou também custou: o provider cobra pelos tokens de entrada
    // mesmo quando a resposta não veio, e ignorá-la faria uma sequência de erros
    // consumir o orçamento sem nunca aparecer no teto.
    return Number(aggregate._sum.costBase ?? 0);
  }
}
