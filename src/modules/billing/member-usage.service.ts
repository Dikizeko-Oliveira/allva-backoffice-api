import { Injectable } from '@nestjs/common';
import { monthWindow } from 'src/modules/creative-lab/domain/month-window';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/** Quanto um membro consumiu das cotas da organização no mês corrente. */
export type MemberUsage = {
  accountId: string;
  name: string;
  email: string;
  creativeAnalyses: number;
  copyGenerations: number;
};

/**
 * O consumo das cotas **por membro**, para o administrador da organização.
 *
 * ## Por que isto existe em vez de uma cota por assento
 *
 * A pergunta que originou este serviço foi "e se uma pessoa consumir as 3.000
 * análises do time?". A resposta óbvia — dividir a cota entre os assentos — cria
 * uma falha pior que a que resolve: um usuário bloqueado enquanto a organização
 * tem 2.800 sobrando. Cota fragmentada fabrica escassez artificial, e o atrito
 * que ela gera é maior que o problema.
 *
 * O que faltava não era parede, era **atribuição**. `creative_analyses.account_id`
 * e `copy_generations.account_id` já registravam quem pediu desde sempre, e
 * ninguém lia. Um administrador que vê "Kevin: 1.240 das 3.000" resolve
 * socialmente em cinco minutos, sem nenhuma regra nova no produto.
 *
 * ## A soma daqui não é o número da tela de assinatura, e não deve ser
 *
 * A cota é reservada no contador (`organization_usage_counters`), que conta
 * **autorização concedida**; isto conta **linha produzida**, que é a única forma
 * de saber de quem foi. Os dois divergem pela devolução: uma geração que caiu
 * por provider fora do ar devolve a reserva e não vira linha. A diferença é o
 * que não foi cobrado — e atribuí-la a alguém seria acusar um membro por uma
 * falha nossa.
 */
@Injectable()
export class MemberUsageService {
  constructor(private readonly prisma: PrismaService) {}

  async forOrganization(
    organizationId: string,
    now: Date = new Date(),
  ): Promise<MemberUsage[]> {
    const window = monthWindow(now);

    /**
     * `FULL JOIN` entre os dois agregados: um membro pode ter analisado sem
     * gerar copy, ou o contrário. Um `JOIN` interno esconderia exatamente quem
     * usa uma feature só — que costuma ser a maioria.
     *
     * A janela é a mesma das guardas (UTC), para a linha do membro somar contra
     * o mesmo mês que o teto governa.
     */
    const rows = await this.prisma.$queryRaw<
      Array<{
        account_id: string;
        name: string;
        email: string;
        creative_analyses: bigint;
        copy_generations: bigint;
      }>
    >`
      WITH analyses AS (
        SELECT "account_id", COUNT(*) AS total
        FROM "creative_analyses"
        WHERE "organization_id" = ${organizationId}
          AND "started_at" >= ${window.since}
          AND "started_at" < ${window.until}
        GROUP BY "account_id"
      ),
      generations AS (
        SELECT "account_id", COUNT(*) AS total
        FROM "copy_generations"
        WHERE "organization_id" = ${organizationId}
          -- Só concluídas, como a guarda conta: geração que caiu por provider
          -- fora do ar não entregou nada e não foi cobrada de ninguém.
          AND "status" = 'COMPLETED'
          AND "created_at" >= ${window.since}
          AND "created_at" < ${window.until}
        GROUP BY "account_id"
      )
      SELECT
        acc."id"    AS account_id,
        acc."name"  AS name,
        acc."email" AS email,
        COALESCE(a.total, 0) AS creative_analyses,
        COALESCE(g.total, 0) AS copy_generations
      FROM analyses a
      FULL JOIN generations g ON g."account_id" = a."account_id"
      JOIN "accounts" acc
        ON acc."id" = COALESCE(a."account_id", g."account_id")
      ORDER BY (COALESCE(a.total, 0) + COALESCE(g.total, 0)) DESC, acc."name" ASC
    `;

    return rows.map((row) => ({
      accountId: row.account_id,
      name: row.name,
      email: row.email,
      creativeAnalyses: Number(row.creative_analyses),
      copyGenerations: Number(row.copy_generations),
    }));
  }
}
