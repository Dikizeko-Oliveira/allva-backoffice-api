import {
  describeOptimization,
  resolveAdOptimization,
  toOptimizationTarget,
} from 'src/modules/integrations/domain/entities/optimization-target';
import type {
  EvidenceGap,
  EvidenceGapNature,
} from 'src/modules/waste/domain/evidence-gaps';
import type { EvidenceGapCode } from 'src/modules/waste/domain/detection-context';
import { Injectable } from '@nestjs/common';
import type { Prisma } from 'generated/prisma/client';
import {
  WasteReadRepositoryInterface,
  type AdEvidenceView,
  type DenormalizationDrift,
  type EvidenceGapCount,
  type EvidenceSummaryView,
  type WasteByAdRow,
  type WasteItemView,
  type WasteListQuery,
  type WasteListResult,
  type WasteRollupGroupBy,
  type WasteRollupResult,
  type WasteSummaryView,
} from 'src/modules/waste/domain/ports/waste-read.repository';
import type {
  FindingKind,
  FindingType,
  ScopeLevel,
  WastePriority,
  WasteResolutionKind,
} from 'src/modules/waste/domain/contracts/finding-catalog';
import type { DataMaturity } from 'src/modules/sync/domain/data-maturity';
import type { EvidenceSufficiency } from 'src/shared/infrastructure/http/envelope/response-meta';
import { moneyView } from 'src/shared/domain/money';
import { unverifiedBefore } from 'src/modules/waste/domain/verification-freshness';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';
import { fromPrismaJsonObject } from 'src/shared/infrastructure/database/prisma/json';

/**
 * A coluna de agrupamento de cada `groupBy`, e a tabela que dá o nome.
 *
 * Declarado como dado porque o `groupBy` vem da query string: interpolar o valor
 * do usuário no SQL é injeção, e um `switch` espalhado pelo método é como a
 * quinta opção nasce sem o `JOIN` certo.
 */
const ROLLUP_DIMENSIONS: Record<
  WasteRollupGroupBy,
  { column: string; table: string | null; nameColumn: string }
> = {
  campaign: { column: 'campaign_id', table: 'campaigns', nameColumn: 'name' },
  adSet: { column: 'ad_set_id', table: 'ad_sets', nameColumn: 'name' },
  adAccount: {
    column: 'ad_account_id',
    table: 'ad_accounts',
    nameColumn: 'name',
  },
  // Plataforma não tem tabela: o próprio valor é o nome.
  platform: { column: 'platform', table: null, nameColumn: '' },
};

const ITEM_INCLUDE = {
  ad: {
    select: {
      id: true,
      lineageId: true,
      name: true,
      platform: true,
      externalAdId: true,
      observedStatus: true,
      campaign: { select: { id: true, name: true } },
      adSet: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.WasteItemInclude;

type ItemRow = Prisma.WasteItemGetPayload<{ include: typeof ITEM_INCLUDE }>;

/**
 * **A subconsulta que corrige a dupla contagem** — uma linha por anúncio.
 *
 * `GROUP BY a."id"` é o que garante que um anúncio com três achados abertos
 * contribua exatamente **uma vez**. As colunas monetárias vêm de `ads` (o `max`
 * de §10.6, já calculado pelo worker); `items` e `critical_items` são contagens
 * sobre o lado N, que são somáveis por construção.
 *
 * O `FROM` é a **view** `open_waste`, sempre. É ela que garante que oportunidade
 * não entre em total de desperdício, e a garantia é da view — não da disciplina
 * de quem escreve a consulta (§10.2). Nenhuma consulta de agregação deste
 * arquivo lê `waste_items` diretamente, e é isso que torna o erro impossível de
 * escrever em vez de proibido por convenção.
 *
 * Parâmetros: `$1` = organização, `$2` = conta de anúncios (opcional).
 */
const PER_AD_COLUMNS = `a."open_waste_amount" AS amount,
                   a."open_waste_amount_base" AS amount_base,
                   a."avoidable_daily_amount_base" AS avoidable_base,
                   a."open_waste_currency" AS currency,
                   a."waste_as_of" AS as_of,
                   COUNT(*) AS items,
                   COUNT(*) FILTER (WHERE w."priority" IN ('HIGH','CRITICAL')) AS critical_items`;

const PER_AD_FROM = `FROM "ads" a
              JOIN "open_waste" w ON w."ad_id" = a."id"
             WHERE a."organization_id" = $1
               AND a."archived_at" IS NULL
               AND ($2::text IS NULL OR a."ad_account_id" = $2::text)
             GROUP BY a."id"`;

const PER_AD_SUBQUERY = `SELECT a."id",
                   ${PER_AD_COLUMNS}
              ${PER_AD_FROM}`;

/**
 * A mesma subconsulta com a dimensão do rollup carregada junto.
 *
 * A coluna vem de `ROLLUP_DIMENSIONS`, nunca da query string: o `groupBy` é
 * entrada do usuário, e interpolá-lo aqui seria injeção. Agrupar por `a."id"`
 * permite selecionar `a."<dimensão>"` sem repeti-la no `GROUP BY` — a
 * dependência funcional da chave primária, que o Postgres reconhece.
 */
function perAdSubqueryGrouped(column: string): string {
  return `SELECT a."id",
                   a."${column}" AS group_key,
                   ${PER_AD_COLUMNS}
              ${PER_AD_FROM}`;
}

const OPTIMIZATION_SELECT = {
  optimizationClass: true,
  conversionEvent: true,
  conversionMeasurable: true,
} as const;

@Injectable()
export class WasteReadPrismaRepository extends WasteReadRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(query: WasteListQuery): Promise<WasteListResult> {
    const rows = await this.prisma.wasteItem.findMany({
      where: this.toWhere(query),
      include: ITEM_INCLUDE,
      // A ordenação padrão é pelo que dá para **interromper hoje**. Ordenar por
      // dano acumulado poria no topo o achado que mais custou no passado —
      // verdadeiro e inútil, porque não há o que fazer com ele.
      orderBy: [{ avoidableDailyBase: 'desc' }, { id: 'asc' }],
      take: query.limit + 1,
    });

    const hasMore = rows.length > query.limit;

    return {
      items: rows.slice(0, query.limit).map(toItemView),
      hasMore,
    };
  }

  async findOne(
    organizationId: string,
    id: string,
  ): Promise<WasteItemView | null> {
    const row = await this.prisma.wasteItem.findFirst({
      where: { id, organizationId },
      include: ITEM_INCLUDE,
    });

    return row ? toItemView(row) : null;
  }

  async openForAd(
    organizationId: string,
    adId: string,
  ): Promise<WasteItemView[]> {
    const rows = await this.prisma.wasteItem.findMany({
      where: { organizationId, adId, resolvedAt: null },
      include: ITEM_INCLUDE,
      orderBy: [{ avoidableDailyBase: 'desc' }, { id: 'asc' }],
    });

    return rows.map(toItemView);
  }

  /**
   * O resumo — **par de grandezas**, somando as colunas denormalizadas.
   *
   * Os totais monetários vêm da subconsulta pré-agregada por anúncio, nunca de
   * `SUM(waste_items.amount)`: somar itens somaria entre tipos, e um anúncio com
   * `ZERO_CONVERSIONS` e `LOW_CTR` entraria com o mesmo gasto duas vezes.
   */
  async evidenceForAd(input: {
    organizationId: string;
    adId: string;
  }): Promise<AdEvidenceView | null> {
    const row = await this.prisma.ad.findFirst({
      where: { id: input.adId, organizationId: input.organizationId },
      select: {
        id: true,
        evidenceGaps: true,
        evidenceGapsAsOf: true,
        adSet: { select: OPTIMIZATION_SELECT },
        campaign: { select: OPTIMIZATION_SELECT },
      },
    });
    if (!row) return null;

    const optimization = resolveAdOptimization(
      row.adSet ? toOptimizationTarget(row.adSet) : null,
      toOptimizationTarget(row.campaign),
    );

    return {
      adId: row.id,
      optimization: {
        ...optimization,
        label: describeOptimization(optimization),
      },
      evaluated: Array.isArray(row.evidenceGaps),
      gaps: Array.isArray(row.evidenceGaps)
        ? (row.evidenceGaps as unknown as EvidenceGap[])
        : [],
      asOf: row.evidenceGapsAsOf,
    };
  }

  /**
   * O resumo das lacunas da organização, **no banco**.
   *
   * `jsonb_array_elements` abre a lista de cada anúncio e o `GROUP BY` conta por
   * motivo: trazer as listas para a memória custaria uma linha por anúncio —
   * milhares no Profissional — para responder uma dúzia de números.
   */
  async evidenceSummary(input: {
    organizationId: string;
    adAccountId?: string;
  }): Promise<EvidenceSummaryView> {
    const scope =
      'a."organization_id" = $1 AND a."archived_at" IS NULL ' +
      'AND a."evidence_gaps" IS NOT NULL ' +
      'AND ($2::text IS NULL OR a."ad_account_id" = $2)';

    const [totals] = await this.prisma.$queryRawUnsafe<
      Array<{
        evaluated: bigint;
        awaiting: bigint;
        fully: bigint;
        outside: bigint;
        as_of: Date | null;
      }>
    >(
      `SELECT COUNT(*) AS evaluated,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM jsonb_array_elements(a."evidence_gaps") g
                 WHERE g->>'nature' = 'AWAITING')) AS awaiting,
              COUNT(*) FILTER (WHERE NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(a."evidence_gaps") g
                 WHERE g->>'nature' IN ('AWAITING', 'STRUCTURAL'))) AS fully,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM jsonb_array_elements(a."evidence_gaps") g
                 WHERE g->>'code' IN ('OBJECTIVE_NOT_CONVERSION', 'CONVERSION_NOT_MEASURABLE'))) AS outside,
              MAX(a."evidence_gaps_as_of") AS as_of
         FROM "ads" a
        WHERE ${scope}`,
      input.organizationId,
      input.adAccountId ?? null,
    );

    const byCode = await this.prisma.$queryRawUnsafe<
      Array<{
        code: EvidenceGapCode;
        nature: EvidenceGapNature;
        ads: bigint;
        next_ready_on: string | null;
        unreachable: bigint;
      }>
    >(
      `SELECT g->>'code' AS code,
              g->>'nature' AS nature,
              COUNT(DISTINCT a."id") AS ads,
              MIN(g->>'estimatedReadyOn') AS next_ready_on,
              COUNT(DISTINCT a."id") FILTER (
                WHERE (g->>'unreachableAtCurrentPace')::boolean) AS unreachable
         FROM "ads" a
        CROSS JOIN LATERAL jsonb_array_elements(a."evidence_gaps") g
        WHERE ${scope}
        GROUP BY 1, 2
        ORDER BY 3 DESC`,
      input.organizationId,
      input.adAccountId ?? null,
    );

    const counts: EvidenceGapCount[] = byCode.map((row) => ({
      code: row.code,
      nature: row.nature,
      ads: Number(row.ads),
      nextReadyOn: row.next_ready_on,
      unreachableAds: Number(row.unreachable),
    }));

    const awaitingDates = counts
      .filter((count) => count.nature === 'AWAITING' && count.nextReadyOn)
      .map((count) => count.nextReadyOn as string)
      .sort();

    return {
      adsEvaluated: Number(totals?.evaluated ?? 0),
      adsAwaitingEvidence: Number(totals?.awaiting ?? 0),
      adsFullyJudged: Number(totals?.fully ?? 0),
      adsOutsideConversionScope: Number(totals?.outside ?? 0),
      byCode: counts,
      nextReadyOn: awaitingDates[0] ?? null,
      asOf: totals?.as_of ?? null,
    };
  }

  async summary(input: {
    organizationId: string;
    windowDays: number;
    adAccountId?: string;
  }): Promise<WasteSummaryView> {
    const [totals] = await this.prisma.$queryRawUnsafe<
      Array<{
        affected_ads: bigint;
        open_count: bigint;
        amount: string | null;
        amount_base: string | null;
        avoidable_base: string | null;
        currencies: bigint;
        currency: string | null;
        as_of: Date | null;
      }>
    >(
      `SELECT COUNT(*) AS affected_ads,
              COALESCE(SUM(x.items), 0) AS open_count,
              COALESCE(SUM(x.amount), 0) AS amount,
              COALESCE(SUM(x.amount_base), 0) AS amount_base,
              COALESCE(SUM(x.avoidable_base), 0) AS avoidable_base,
              COUNT(DISTINCT x.currency) AS currencies,
              MIN(x.currency) AS currency,
              MAX(x.as_of) AS as_of
         FROM (${PER_AD_SUBQUERY}) x`,
      input.organizationId,
      input.adAccountId ?? null,
    );

    const [byPriority, byType, mismatch, unverified, organization] =
      await Promise.all([
        this.prisma.wasteItem.groupBy({
          by: ['priority'],
          where: this.openWasteWhere(input.organizationId),
          _count: { _all: true },
        }),
        this.prisma.wasteItem.groupBy({
          by: ['type'],
          where: this.openWasteWhere(input.organizationId),
          _count: { _all: true },
        }),
        // DEC-11: itens de outra janela ficam **fora** do agregado e são contados
        // à parte. É legado de troca de configuração, e escondê-lo faria o total
        // encolher sem explicação no dia em que alguém mexe em `scoringWindowDays`.
        this.prisma.wasteItem.count({
          where: {
            ...this.openWasteWhere(input.organizationId),
            windowDays: { not: input.windowDays },
          },
        }),
        /**
         * A parcela que a varredura não reconfirmou — ver `unverified` na porta.
         *
         * Uma consulta só devolve as duas coisas que a tela precisa: quantos são e
         * desde quando o mais antigo espera. O segundo é o que transforma "há
         * achados velhos" em "há achados de 80 dias", que é a frase acionável.
         */
        this.prisma.wasteItem.aggregate({
          where: {
            ...this.openWasteWhere(input.organizationId),
            lastSeenAt: { lt: unverifiedBefore(new Date()) },
          },
          _count: { _all: true },
          _min: { lastSeenAt: true },
        }),
        this.prisma.organization.findUnique({
          where: { id: input.organizationId },
          select: { baseCurrency: true },
        }),
      ]);

    const base = organization?.baseCurrency ?? 'BRL';
    // Contas em moedas diferentes: o total na moeda original deixa de existir
    // como número — somar BRL com USD produz uma quantia que não é dinheiro em
    // moeda nenhuma. Nesse caso os dois lados reportam a moeda-base, declarada.
    const mixed = Number(totals?.currencies ?? 0) > 1;
    const currency = mixed ? base : (totals?.currency ?? base);

    return {
      openCount: Number(totals?.open_count ?? 0),
      affectedAds: Number(totals?.affected_ads ?? 0),
      incurred: moneyView({
        value: mixed
          ? Number(totals?.amount_base ?? 0)
          : Number(totals?.amount ?? 0),
        currency,
        valueBase: Number(totals?.amount_base ?? 0),
        baseCurrency: base,
      }),
      avoidableDaily: moneyView({
        // O evitável é denormalizado só em moeda-base (§5.4): é o número que
        // ordena a tela principal, e ordenar exige uma unidade só.
        value: Number(totals?.avoidable_base ?? 0),
        currency: base,
        valueBase: Number(totals?.avoidable_base ?? 0),
        baseCurrency: base,
      }),
      byPriority: countsOf<WastePriority>(byPriority, 'priority'),
      byType: countsOf<FindingType>(byType, 'type'),
      asOf: totals?.as_of ?? null,
      excludedByWindowMismatch: mismatch,
      unverified: {
        count: unverified._count._all,
        oldestSeenAt: unverified._min.lastSeenAt ?? null,
      },
    };
  }

  /**
   * O rollup de §10.8 — **com a subconsulta pré-agregada por anúncio**.
   *
   * A subconsulta não é otimização, é correção. Somar uma coluna do lado 1 de um
   * join 1:N a multiplica pela cardinalidade do lado N: um anúncio com três
   * achados abertos entraria **três vezes** no número de capa. É o Apêndice A
   * nº 2 — a dupla contagem que motivou a v2.0 inteira — reaparecendo no eixo do
   * achado em vez de no eixo do nível.
   *
   * **A janela não filtra o join** (DEC-11). A denormalização em `ads` é sempre
   * da janela ativa da organização e não tem dimensão de janela; filtrar por
   * `w.window_days` enquanto se soma uma coluna sem janela é incoerente. A
   * janela vigente é declarada em `meta.provenance`.
   */
  async rollup(input: {
    organizationId: string;
    groupBy: WasteRollupGroupBy;
    windowDays: number;
    limit: number;
  }): Promise<WasteRollupResult> {
    const dimension = ROLLUP_DIMENSIONS[input.groupBy];
    const inner = perAdSubqueryGrouped(dimension.column);
    const limit = Math.max(1, Math.min(input.limit, 100));

    const sql = dimension.table
      ? `SELECT g."id"::text AS group_id,
                g."${dimension.nameColumn}" AS group_name,
                COUNT(*) AS affected_ads,
                COALESCE(SUM(x.amount_base), 0) AS open_waste_base,
                COALESCE(SUM(x.avoidable_base), 0) AS avoidable_daily_base,
                COALESCE(SUM(x.critical_items), 0) AS critical_items
           FROM (${inner}) x
           JOIN "${dimension.table}" g ON g."id" = x.group_key
          GROUP BY g."id", g."${dimension.nameColumn}"
          ORDER BY avoidable_daily_base DESC
          LIMIT ${limit}`
      : `SELECT x.group_key::text AS group_id,
                x.group_key::text AS group_name,
                COUNT(*) AS affected_ads,
                COALESCE(SUM(x.amount_base), 0) AS open_waste_base,
                COALESCE(SUM(x.avoidable_base), 0) AS avoidable_daily_base,
                COALESCE(SUM(x.critical_items), 0) AS critical_items
           FROM (${inner}) x
          GROUP BY x.group_key
          ORDER BY avoidable_daily_base DESC
          LIMIT ${limit}`;

    const [rows, mismatch, organization] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        Array<{
          group_id: string;
          group_name: string;
          affected_ads: bigint;
          open_waste_base: string;
          avoidable_daily_base: string;
          critical_items: bigint;
        }>
      >(sql, input.organizationId, null),
      this.prisma.wasteItem.count({
        where: {
          ...this.openWasteWhere(input.organizationId),
          windowDays: { not: input.windowDays },
        },
      }),
      this.prisma.organization.findUnique({
        where: { id: input.organizationId },
        select: { baseCurrency: true },
      }),
    ]);

    return {
      rows: rows.map((row) => ({
        groupId: row.group_id,
        groupName: row.group_name,
        affectedAds: Number(row.affected_ads),
        openWasteBase: Number(row.open_waste_base),
        avoidableDailyBase: Number(row.avoidable_daily_base),
        criticalItems: Number(row.critical_items),
      })),
      baseCurrency: organization?.baseCurrency ?? null,
      excludedByWindowMismatch: mismatch,
    };
  }

  /**
   * `/waste/by-ad` — paginado sobre `ads`, não sobre `waste_items`.
   *
   * As colunas denormalizadas já carregam o `max` de §10.6, então uma linha por
   * anúncio sai do banco pronta. Agrupar itens em memória partiria um anúncio
   * entre duas páginas e reportaria metade do total dele na primeira.
   */
  async byAd(input: {
    organizationId: string;
    limit: number;
    cursor?: { avoidableDailyBase: number; id: string };
  }): Promise<{ rows: WasteByAdRow[]; hasMore: boolean }> {
    const ads = await this.prisma.ad.findMany({
      where: {
        organizationId: input.organizationId,
        archivedAt: null,
        openWasteCount: { gt: 0 },
        ...(input.cursor
          ? {
              OR: [
                {
                  avoidableDailyAmountBase: {
                    lt: input.cursor.avoidableDailyBase,
                  },
                },
                {
                  avoidableDailyAmountBase: input.cursor.avoidableDailyBase,
                  id: { gt: input.cursor.id },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        lineageId: true,
        name: true,
        platform: true,
        externalAdId: true,
        observedStatus: true,
        openWasteCount: true,
        openWasteAmount: true,
        openWasteAmountBase: true,
        openWasteCurrency: true,
        avoidableDailyAmountBase: true,
        wasteAsOf: true,
        campaign: { select: { id: true, name: true } },
        adSet: { select: { id: true, name: true } },
      },
      orderBy: [{ avoidableDailyAmountBase: 'desc' }, { id: 'asc' }],
      take: input.limit + 1,
    });

    const hasMore = ads.length > input.limit;
    const page = hasMore ? ads.slice(0, input.limit) : ads;

    const items = await this.prisma.wasteItem.findMany({
      where: {
        organizationId: input.organizationId,
        adId: { in: page.map((ad) => ad.id) },
        findingKind: 'WASTE',
        resolvedAt: null,
      },
      select: {
        adId: true,
        type: true,
        priority: true,
        baseCurrency: true,
      },
    });

    const byAdId = new Map<string, typeof items>();
    for (const item of items) {
      const bucket = byAdId.get(item.adId) ?? [];
      bucket.push(item);
      byAdId.set(item.adId, bucket);
    }

    const base = items[0]?.baseCurrency ?? null;
    const rank: WastePriority[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

    return {
      rows: page.map((ad) => {
        const adItems = byAdId.get(ad.id) ?? [];
        const currency = ad.openWasteCurrency ?? base ?? 'BRL';
        const baseCurrency = adItems[0]?.baseCurrency ?? base ?? currency;

        return {
          ad: {
            id: ad.id,
            lineageId: ad.lineageId,
            name: ad.name,
            platform: ad.platform,
            externalAdId: ad.externalAdId,
            observedStatus: ad.observedStatus,
            campaign: { id: ad.campaign.id, name: ad.campaign.name },
            adSet: ad.adSet ? { id: ad.adSet.id, name: ad.adSet.name } : null,
          },
          openCount: ad.openWasteCount,
          incurred: moneyView({
            value: Number(ad.openWasteAmount),
            currency,
            valueBase: Number(ad.openWasteAmountBase),
            baseCurrency,
          }),
          avoidableDaily: moneyView({
            value: Number(ad.avoidableDailyAmountBase),
            currency: baseCurrency,
            valueBase: Number(ad.avoidableDailyAmountBase),
            baseCurrency,
          }),
          types: adItems.map((item) => item.type as FindingType),
          worstPriority: adItems.reduce<WastePriority>(
            (worst, item) =>
              rank.indexOf(item.priority as WastePriority) > rank.indexOf(worst)
                ? (item.priority as WastePriority)
                : worst,
            'LOW',
          ),
          wasteAsOf: ad.wasteAsOf,
        };
      }),
      hasMore,
    };
  }

  /**
   * C3 — a divergência entre a denormalização e a agregação real.
   *
   * A agregação usa `MAX`, não `SUM`, porque é o `max` que §10.6 manda guardar:
   * a consulta que detecta o drift tem que aplicar exatamente a mesma regra da
   * que grava, senão ela mesma vira a fonte do "drift".
   */
  async findDenormalizationDrift(input: {
    adAccountId: string;
  }): Promise<DenormalizationDrift[]> {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<{
        ad_id: string;
        organization_id: string;
        stored_count: number;
        stored_amount_base: string;
        stored_avoidable: string;
        actual_count: bigint;
        actual_amount: string;
        actual_amount_base: string;
        actual_currency: string | null;
        actual_avoidable: string;
      }>
    >(
      `SELECT a."id" AS ad_id,
              a."organization_id",
              a."open_waste_count" AS stored_count,
              a."open_waste_amount_base" AS stored_amount_base,
              a."avoidable_daily_amount_base" AS stored_avoidable,
              COALESCE(w.items, 0) AS actual_count,
              COALESCE(w.amount, 0) AS actual_amount,
              COALESCE(w.amount_base, 0) AS actual_amount_base,
              w.currency AS actual_currency,
              COALESCE(w.avoidable_base, 0) AS actual_avoidable
         FROM "ads" a
         LEFT JOIN (
           SELECT "ad_id",
                  COUNT(*) AS items,
                  MAX("incurred_amount") AS amount,
                  MAX("incurred_amount_base") AS amount_base,
                  MAX("avoidable_daily_base") AS avoidable_base,
                  MIN("currency") AS currency
             FROM "open_waste"
            GROUP BY "ad_id"
         ) w ON w."ad_id" = a."id"
        WHERE a."ad_account_id" = $1
          AND (a."open_waste_count" <> COALESCE(w.items, 0)
            OR ABS(a."open_waste_amount_base" - COALESCE(w.amount_base, 0)) > 0.01
            OR ABS(a."avoidable_daily_amount_base" - COALESCE(w.avoidable_base, 0)) > 0.01)`,
      input.adAccountId,
    );

    return rows.map((row) => ({
      adId: row.ad_id,
      organizationId: row.organization_id,
      stored: {
        openWasteCount: Number(row.stored_count),
        openWasteAmountBase: Number(row.stored_amount_base),
        avoidableDailyAmountBase: Number(row.stored_avoidable),
      },
      actual: {
        openWasteCount: Number(row.actual_count),
        openWasteAmount: Number(row.actual_amount),
        openWasteAmountBase: Number(row.actual_amount_base),
        openWasteCurrency: row.actual_currency,
        avoidableDailyAmountBase: Number(row.actual_avoidable),
      },
    }));
  }

  /** Aberto **e** desperdício: a mesma definição da view `open_waste`. */
  private openWasteWhere(organizationId: string): Prisma.WasteItemWhereInput {
    return {
      organizationId,
      findingKind: 'WASTE',
      resolvedAt: null,
    };
  }

  private toWhere(query: WasteListQuery): Prisma.WasteItemWhereInput {
    const state = query.state ?? 'open';

    return {
      organizationId: query.organizationId,
      ...(query.findingKind ? { findingKind: query.findingKind } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...(query.priority ? { priority: query.priority } : {}),
      ...(query.dataMaturity ? { dataMaturity: query.dataMaturity } : {}),
      ...(query.adId ? { adId: query.adId } : {}),
      ...(query.minAvoidableDailyBase !== undefined
        ? { avoidableDailyBase: { gte: query.minAvoidableDailyBase } }
        : {}),
      ...(state === 'open' ? { resolvedAt: null } : {}),
      ...(state === 'resolved' ? { resolvedAt: { not: null } } : {}),
      ...(query.adAccountId || query.campaignId || query.adSetId
        ? {
            ad: {
              ...(query.adAccountId ? { adAccountId: query.adAccountId } : {}),
              ...(query.campaignId ? { campaignId: query.campaignId } : {}),
              ...(query.adSetId ? { adSetId: query.adSetId } : {}),
            },
          }
        : {}),
      ...(query.cursor
        ? {
            OR: [
              { avoidableDailyBase: { lt: Number(query.cursor.keys[0]) } },
              {
                avoidableDailyBase: Number(query.cursor.keys[0]),
                id: { gt: query.cursor.id },
              },
            ],
          }
        : {}),
    };
  }
}

function toItemView(row: ItemRow): WasteItemView {
  return {
    id: row.id,
    ad: {
      id: row.ad.id,
      lineageId: row.ad.lineageId,
      name: row.ad.name,
      platform: row.ad.platform,
      externalAdId: row.ad.externalAdId,
      observedStatus: row.ad.observedStatus,
      campaign: { id: row.ad.campaign.id, name: row.ad.campaign.name },
      adSet: row.ad.adSet
        ? { id: row.ad.adSet.id, name: row.ad.adSet.name }
        : null,
    },
    type: row.type as FindingType,
    findingKind: row.findingKind as FindingKind,
    priority: row.priority as WastePriority,
    windowDays: row.windowDays,
    incurred: moneyView({
      value: Number(row.incurredAmount),
      currency: row.currency,
      valueBase: Number(row.incurredAmountBase),
      baseCurrency: row.baseCurrency,
    }),
    avoidableDaily: moneyView({
      value: Number(row.avoidableDailyAmount),
      currency: row.currency,
      valueBase: Number(row.avoidableDailyBase),
      baseCurrency: row.baseCurrency,
    }),
    diagnosis: row.diagnosis,
    evidence: fromPrismaJsonObject(row.evidence),
    evidenceSufficiency: row.evidenceSufficiency as EvidenceSufficiency,
    scopeLevel: row.scopeLevel as ScopeLevel,
    dataMaturity: row.dataMaturity as DataMaturity | null,
    detectorVersion: row.detectorVersion,
    detectorProfileVersion: row.detectorProfileVersion,
    occurrences: row.occurrences,
    detectedAt: row.detectedAt,
    lastSeenAt: row.lastSeenAt,
    staleObservation: row.staleObservation,
    resolvedAt: row.resolvedAt,
    resolutionKind: row.resolutionKind as WasteResolutionKind | null,
  };
}

/** `groupBy` do Prisma virando `Record<enum, contagem>`, sem `any` no caminho. */
function countsOf<T extends string>(
  groups: Array<Record<string, unknown> & { _count: { _all: number } }>,
  key: string,
): Record<T, number> {
  const counts = {} as Record<T, number>;
  for (const group of groups) {
    counts[group[key] as T] = group._count._all;
  }
  return counts;
}
