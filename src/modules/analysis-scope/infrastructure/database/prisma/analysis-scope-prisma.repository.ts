import { Injectable } from '@nestjs/common';
import {
  AnalysisScopeRepositoryInterface,
  type AnalysisScopeOutcome,
} from 'src/modules/analysis-scope/domain/ports/analysis-scope.repository';
import { splitScope } from 'src/modules/analysis-scope/domain/scope-split';
import {
  SWEEPABLE_AD_ACCOUNT_SQL,
  linkedAdAccountWhere,
  sweepableAdAccountWhere,
} from 'src/modules/integrations/infrastructure/database/prisma/sweepable-ad-account.where';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

@Injectable()
export class AnalysisScopePrismaRepository extends AnalysisScopeRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Inclusive as organizações cujos anúncios estão todos em conta desvinculada:
   * é a passagem por `markEligible` que limpa o carimbo deles.
   */
  async listOrganizationsWithAds(): Promise<string[]> {
    const rows = await this.prisma.ad.groupBy({
      by: ['organizationId'],
      where: { archivedAt: null },
    });

    return rows.map((row) => row.organizationId);
  }

  /**
   * Duas escritas, numa transação: quem entra e quem sai.
   *
   * A ordem importa. Limpar tudo e depois carimbar deixaria uma janela em que a
   * organização inteira está fora do escopo — e o job de scoring roda de
   * madrugada, exatamente quando ninguém veria. Carimbar primeiro e limpar o
   * complemento nunca produz esse estado: no pior caso um anúncio fica elegível
   * uma noite a mais, que é o erro do lado certo.
   */
  async markEligible(input: {
    organizationId: string;
    limit: number | null;
    since: Date;
    until: Date;
    now: Date;
  }): Promise<AnalysisScopeOutcome> {
    const selected = await this.selectScope(input);

    const [eligible, excludedByPlanLimit] = await this.prisma.$transaction([
      this.prisma.ad.updateMany({
        where: { organizationId: input.organizationId, id: { in: selected } },
        /**
         * As duas colunas na mesma escrita, e a segunda **nunca é apagada**.
         *
         * `analysisEligibleAt` diz "está dentro agora" e a limpeza abaixo a zera
         * para quem saiu. `analysisLastScopedAt` diz "quando foi a última vez" e
         * é a memória de que o rodízio depende: se ela fosse zerada junto, a
         * faixa de negligência perderia a ordem no primeiro ciclo e viraria
         * sorteio.
         */
        data: {
          analysisEligibleAt: input.now,
          analysisLastScopedAt: input.now,
        },
      }),
      this.prisma.ad.updateMany({
        where: {
          organizationId: input.organizationId,
          id: { notIn: selected },
          analysisEligibleAt: { not: null },
        },
        data: { analysisEligibleAt: null },
      }),
    ]);

    return {
      organizationId: input.organizationId,
      eligible: eligible.count,
      excludedByPlanLimit: excludedByPlanLimit.count,
    };
  }

  /**
   * A fila do rodízio — **o mesmo filtro de `selectRotation`**, sem o `LIMIT`.
   *
   * Repetir o predicado aqui é o preço de a contagem ser verdadeira: se ela
   * divergir da seleção, a tela promete um ciclo que a régua não cumpre. O
   * `NOT NULL` em `analysis_eligible_at` é o que separa "está esperando" de
   * "entrou hoje".
   */
  async countRotationQueue(input: {
    organizationId: string;
    since: Date;
    until: Date;
  }): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT COUNT(*) AS waiting
      FROM "ads" a
      JOIN (
        SELECT s."ad_id"
        FROM "ad_metric_snapshots" s
        WHERE s."organization_id" = ${input.organizationId}
          AND s."date" >= ${input.since}::date
          AND s."date" <= ${input.until}::date
        GROUP BY s."ad_id"
        HAVING SUM(s."spend_base") > 0 OR SUM(s."impressions") > 0
      ) m ON m."ad_id" = a."id"
      JOIN "ad_accounts" acc ON acc."id" = a."ad_account_id"
      WHERE a."organization_id" = ${input.organizationId}
        AND a."archived_at" IS NULL
        AND ${SWEEPABLE_AD_ACCOUNT_SQL}
        AND a."analysis_eligible_at" IS NULL
    `;

    return Number(row?.waiting ?? 0);
  }

  /**
   * Fora do conjunto — só de conta com credencial viva.
   *
   * Anúncio de conta desvinculada também fica sem carimbo, mas não está fora
   * **por teto**: contá-lo inflaria o "anúncios fora da análise" da tela de
   * upgrade com anúncios que plano nenhum faria analisar. O de conta congelada
   * continua contando, porque esse está fora por plano.
   */
  async countExcluded(organizationId: string): Promise<number> {
    return this.prisma.ad.count({
      where: {
        organizationId,
        archivedAt: null,
        analysisEligibleAt: null,
        adAccount: { is: linkedAdAccountWhere() },
      },
    });
  }

  /**
   * Dentro do conjunto — só de conta com credencial viva. O carimbo de uma
   * conta que acabou de perder a credencial só some na corrida seguinte, e até
   * lá não pode contar contra o teto de anúncios monitorados.
   */
  async countEligible(organizationId: string): Promise<number> {
    return this.prisma.ad.count({
      where: {
        organizationId,
        archivedAt: null,
        analysisEligibleAt: { not: null },
        adAccount: { is: linkedAdAccountWhere() },
      },
    });
  }

  /**
   * O conjunto da noite — **núcleo estável mais faixa de rodízio**.
   *
   * ## O defeito que isto corrige
   *
   * Escolher sempre os N que mais gastam parece óbvio e tem um furo: o ranking
   * de gasto é estável, então os mesmos anúncios eram olhados para sempre. Um
   * cliente com 5.000 anúncios no plano de 300 tinha 4.700 que a Allva nunca
   * analisou — e o anúncio da cauda que começa a desperdiçar só entra em cena
   * quando sobe no ranking, o que ele só faz **gastando mais**. O produto
   * encontrava o problema depois que o dinheiro tinha saído.
   *
   * ## O teto continua sendo o teto
   *
   * São `limit` anúncios por noite, nem mais nem menos: o que muda é que
   * `limit` deixa de ser sempre o mesmo conjunto. O rodízio não compra
   * cobertura com cota — compra com **rotação**.
   *
   * ## E continua determinístico
   *
   * Nada aqui sorteia. O núcleo ordena por gasto, o rodízio por negligência com
   * desempate em gasto e `id` — duas corridas sobre o mesmo estado produzem o
   * mesmo conjunto, que é a propriedade que o desenho original protegia ao
   * recusar "por recência".
   */
  private async selectScope(input: {
    organizationId: string;
    limit: number | null;
    since: Date;
    until: Date;
  }): Promise<string[]> {
    const split = splitScope(input.limit);

    // Sem teto: todo anúncio vivo entra, e não há o que dividir.
    if (split === null) return this.selectAll(input.organizationId);
    if (split.core + split.rotation === 0) return [];

    const core = await this.selectCore({ ...input, split });

    if (split.rotation === 0) return core;

    const rotation = await this.selectRotation({
      ...input,
      exclude: core,
      take: split.rotation,
    });

    return [...core, ...rotation];
  }

  private async selectAll(organizationId: string): Promise<string[]> {
    const all = await this.prisma.ad.findMany({
      where: {
        organizationId,
        archivedAt: null,
        adAccount: { is: sweepableAdAccountWhere(new Date()) },
      },
      select: { id: true },
    });

    return all.map((row) => row.id);
  }

  /**
   * O núcleo: os que mais gastaram na janela, em **moeda-base** — com histerese.
   *
   * Gasto é a única ordenação defensável: o produto afirma coisas sobre dinheiro
   * queimado, e os que mais gastam são exatamente onde o desperdício pode estar.
   *
   * **A histerese é o que impede o corte de oscilar.** Sem ela, dois anúncios
   * com gasto praticamente igual na fronteira trocam de lugar noite após noite
   * conforme centavos entram — e o achado de um deles para de ser reverificado
   * sem que nada tenha mudado na mídia. Um incumbente (já elegível) mantém a
   * vaga enquanto estiver dentro de `coreHighWater`; os recém-chegados disputam
   * o que sobra, por gasto.
   *
   * `LEFT JOIN` com `COALESCE`: um anúncio recém-descoberto ainda não tem
   * snapshot, e um `INNER JOIN` o excluiria do ranking — sumiria da análise
   * justamente o anúncio novo, que é o que mais precisa ser olhado. Ele entra
   * com gasto zero e disputa a vaga por baixo, que é o lugar certo.
   */
  private async selectCore(input: {
    organizationId: string;
    since: Date;
    until: Date;
    split: { core: number; coreHighWater: number };
  }): Promise<string[]> {
    if (input.split.core <= 0) return [];

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      WITH ranked AS (
        SELECT
          a."id",
          a."analysis_eligible_at" IS NOT NULL AS incumbent,
          ROW_NUMBER() OVER (
            ORDER BY COALESCE(m.spend_base, 0) DESC, a."id" ASC
          ) AS position
        FROM "ads" a
        LEFT JOIN (
          SELECT s."ad_id", SUM(s."spend_base") AS spend_base
          FROM "ad_metric_snapshots" s
          WHERE s."organization_id" = ${input.organizationId}
            AND s."date" >= ${input.since}::date
            AND s."date" <= ${input.until}::date
          GROUP BY s."ad_id"
        ) m ON m."ad_id" = a."id"
        JOIN "ad_accounts" acc ON acc."id" = a."ad_account_id"
        WHERE a."organization_id" = ${input.organizationId}
          AND a."archived_at" IS NULL
          -- Anúncio de conta congelada ou desvinculada sai da análise junto com
          -- a conta. Sem esta junção, parar o sync deixaria os anúncios
          -- ocupando vaga no teto com dado que ninguém mais atualiza.
          AND ${SWEEPABLE_AD_ACCOUNT_SQL}
      )
      SELECT "id" FROM ranked
      ORDER BY
        -- Incumbente dentro da faixa de histerese primeiro: é o que segura o
        -- corte parado quando o gasto oscila por centavos.
        CASE
          WHEN incumbent AND position <= ${input.split.coreHighWater} THEN 0
          ELSE 1
        END,
        position
      LIMIT ${input.split.core}
    `;

    return rows.map((row) => row.id);
  }

  /**
   * A faixa de rodízio: a cauda, ordenada por **negligência**.
   *
   * `analysis_last_scoped_at` nulo é "nunca analisado" e vem primeiro — quem
   * jamais foi olhado tem prioridade sobre quem foi olhado há muito tempo. O
   * desempate é por gasto, então dentro da mesma antiguidade a vaga vai para
   * quem queima mais.
   *
   * ## O filtro de entrega é o que torna o ciclo viável
   *
   * Sem ele, o rodízio gasta vagas em anúncio pausado, sem impressão e sem
   * gasto — e a cauda de uma conta real é majoritariamente isso. Um anúncio que
   * não entrega não pode estar desperdiçando: analisá-lo não é justiça, é vaga
   * jogada fora que atrasa o anúncio vivo da fila. Este filtro encurta o ciclo
   * mais do que o rodízio em si.
   */
  private async selectRotation(input: {
    organizationId: string;
    since: Date;
    until: Date;
    exclude: string[];
    take: number;
  }): Promise<string[]> {
    if (input.take <= 0) return [];

    const excluded = input.exclude.length > 0 ? input.exclude : [''];

    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT a."id"
      FROM "ads" a
      JOIN (
        SELECT s."ad_id", SUM(s."spend_base") AS spend_base
        FROM "ad_metric_snapshots" s
        WHERE s."organization_id" = ${input.organizationId}
          AND s."date" >= ${input.since}::date
          AND s."date" <= ${input.until}::date
        GROUP BY s."ad_id"
        -- JOIN interno, ao contrário do LEFT JOIN do núcleo: aqui o anúncio
        -- sem entrega nenhuma na janela fica de fora de propósito.
        HAVING SUM(s."spend_base") > 0 OR SUM(s."impressions") > 0
      ) m ON m."ad_id" = a."id"
      JOIN "ad_accounts" acc ON acc."id" = a."ad_account_id"
      WHERE a."organization_id" = ${input.organizationId}
        AND a."archived_at" IS NULL
        AND ${SWEEPABLE_AD_ACCOUNT_SQL}
        AND a."id" <> ALL(${excluded})
      ORDER BY
        a."analysis_last_scoped_at" ASC NULLS FIRST,
        COALESCE(m.spend_base, 0) DESC,
        a."id" ASC
      LIMIT ${input.take}
    `;

    return rows.map((row) => row.id);
  }
}
