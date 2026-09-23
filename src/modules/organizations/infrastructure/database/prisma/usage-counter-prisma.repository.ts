import { Injectable } from '@nestjs/common';
import { UsageCounterPortInterface } from 'src/modules/organizations/domain/ports';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class UsageCounterPrismaRepository extends UsageCounterPortInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * A reserva atômica — **uma instrução, e a trava é do Postgres**.
   *
   * `ON CONFLICT … DO UPDATE … WHERE` é a peça que faz isto funcionar: o
   * predicado do `WHERE` é avaliado **depois** de a linha em conflito estar
   * travada, então o segundo pedido concorrente já enxerga o incremento do
   * primeiro. Zero linhas devolvidas significa "o teto foi atingido".
   *
   * **Não dá para escrever isto com o `upsert` do Prisma**, e é a razão do SQL
   * cru: o `upsert` não expressa condição no ramo de atualização, então a
   * verificação voltaria para a aplicação — que é de onde ela precisa sair.
   *
   * ## O ramo de inserção não passa pelo `WHERE`, e por isso o teto zero é
   * barrado antes
   *
   * Numa organização sem linha no período, o `INSERT` acontece direto e nada
   * avalia o predicado — `used` nasceria 1 mesmo com teto 0. Um plano
   * irresolúvel tem teto 0 (`planQuota` fecha na dúvida), então este caso é
   * real, não teórico. Recusá-lo aqui, antes de tocar a tabela, é mais honesto
   * que um `INSERT … WHERE` que só existiria para esse caso.
   */
  async reserve(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
    limit: number | null;
  }): Promise<number | null> {
    if (input.limit !== null && input.limit <= 0) return null;

    const rows =
      input.limit === null
        ? await this.prisma.$queryRaw<Array<{ used: number }>>`
            INSERT INTO "organization_usage_counters"
              ("organization_id", "feature", "period_start", "used", "updated_at")
            VALUES (${input.organizationId}, ${input.feature}, ${input.periodStart}, 1, NOW())
            ON CONFLICT ("organization_id", "feature", "period_start")
            DO UPDATE SET
              "used" = "organization_usage_counters"."used" + 1,
              "updated_at" = NOW()
            RETURNING "used"
          `
        : await this.prisma.$queryRaw<Array<{ used: number }>>`
            INSERT INTO "organization_usage_counters"
              ("organization_id", "feature", "period_start", "used", "updated_at")
            VALUES (${input.organizationId}, ${input.feature}, ${input.periodStart}, 1, NOW())
            ON CONFLICT ("organization_id", "feature", "period_start")
            DO UPDATE SET
              "used" = "organization_usage_counters"."used" + 1,
              "updated_at" = NOW()
            WHERE "organization_usage_counters"."used" < ${input.limit}
            RETURNING "used"
          `;

    return rows[0]?.used ?? null;
  }

  /**
   * A devolução — e `GREATEST` em vez de deixar chegar a negativo.
   *
   * Um contador negativo transformaria a cota em ilimitada até que alguém
   * notasse, que é a pior falha possível para uma guarda de cobrança. Absorver
   * uma devolução a mais é a degradação certa: perde-se uma unidade de precisão,
   * nunca a parede. A restrição `CHECK (used >= 0)` no banco é a segunda
   * barreira, para um caminho futuro que esqueça esta.
   */
  async release(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
  }): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "organization_usage_counters"
      SET "used" = GREATEST("used" - 1, 0), "updated_at" = NOW()
      WHERE "organization_id" = ${input.organizationId}
        AND "feature" = ${input.feature}
        AND "period_start" = ${input.periodStart}
    `;
  }

  async read(input: {
    organizationId: string;
    feature: string;
    periodStart: Date;
  }): Promise<number> {
    const row = await this.prisma.organizationUsageCounter.findUnique({
      where: {
        organizationId_feature_periodStart: {
          organizationId: input.organizationId,
          feature: input.feature,
          periodStart: input.periodStart,
        },
      },
      select: { used: true },
    });

    return row?.used ?? 0;
  }
}
