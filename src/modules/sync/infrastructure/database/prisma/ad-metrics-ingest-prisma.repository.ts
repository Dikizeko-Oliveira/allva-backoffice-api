import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AdMetricUpsert,
  AdMetricsIngestRepositoryInterface,
  IngestedMetricsSummary,
} from 'src/modules/sync/domain/ports/ad-metrics-ingest.repository';
import { PrismaService } from 'src/shared/infrastructure/database/prisma/prisma.service';

/**
 * Colunas gravadas por linha, na ordem do `INSERT`. São 32, então um lote de 250
 * usa 8.000 parâmetros — folgado dentro do teto de 65.535 do protocolo, e grande
 * o bastante para que a viagem ao banco valha a pena.
 */
const COLUMNS = [
  'id',
  'ad_id',
  'organization_id',
  'ad_account_id',
  'platform',
  'date',
  'granularity',
  'campaign_id',
  'ad_set_id',
  'creative_id',
  'spend',
  'impressions',
  'clicks',
  'conversions',
  'revenue',
  'reach',
  'frequency',
  'video_views',
  'engagement',
  'thumbstop_rate',
  'hold_rate',
  'hides',
  'hide_all_for',
  'reports',
  'unlikes',
  'currency',
  'base_currency',
  'spend_base',
  'revenue_base',
  'fx_rate',
  'fx_as_of',
  'fx_source',
  'normalization_pending',
  'account_timezone',
  'attribution_setting',
  'synced_at',
] as const;

/**
 * Colunas reescritas quando a linha já existe — a janela de re-declaração.
 *
 * `id`, `ad_id`, `date` e `granularity` ficam de fora porque são a identidade da
 * linha; `currency`, `base_currency` e `account_timezone` também, porque
 * mudá-las retroativamente reescreveria o passado com a configuração de hoje.
 */
const UPDATED_COLUMNS = COLUMNS.filter(
  (column) =>
    ![
      'id',
      'ad_id',
      'date',
      'granularity',
      'organization_id',
      'ad_account_id',
      'platform',
      'currency',
      'base_currency',
      'account_timezone',
    ].includes(column),
);

const BATCH_SIZE = 250;

@Injectable()
export class AdMetricsIngestPrismaRepository extends AdMetricsIngestRepositoryInterface {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  /**
   * Upsert por `(adId, date, granularity)` — a chave da janela de re-declaração.
   *
   * A mesma linha é reescrita a cada ingest enquanto estiver dentro da janela, e
   * é assim que uma conversão que chega em D+9 atribuída a D entra na série.
   * Sem o upsert por essa chave, ou perderíamos a re-declaração ou teríamos duas
   * linhas para o mesmo dia — e a segunda dobraria o gasto do dia na agregação.
   */
  async upsertMany(rows: AdMetricUpsert[]): Promise<IngestedMetricsSummary> {
    const summary: IngestedMetricsSummary = {
      rows: 0,
      pendingNormalization: 0,
      latestDateByAd: new Map(),
    };

    for (let index = 0; index < rows.length; index += BATCH_SIZE) {
      const batch = rows.slice(index, index + BATCH_SIZE);
      await this.writeBatch(batch);

      for (const row of batch) {
        summary.rows += 1;
        if (row.normalizationPending) summary.pendingNormalization += 1;

        const latest = summary.latestDateByAd.get(row.adId);
        if (!latest || row.date > latest) {
          summary.latestDateByAd.set(row.adId, row.date);
        }
      }
    }

    return summary;
  }

  /**
   * Um `INSERT ... ON CONFLICT DO UPDATE` multi-linha por lote.
   *
   * A primeira redação usava `prisma.upsert` linha a linha dentro de uma
   * transação: numa conta de 5 mil anúncios com janela de 14 dias são **70 mil**
   * statements, e o benchmark de §17.2 media 31 s só para 500 anúncios. O alvo
   * de < 5 min para 5 mil não caberia — e o custo não estava na plataforma, que
   * é a única parte que não temos como consertar.
   *
   * O `ON CONFLICT` é sobre `(ad_id, date, granularity)`, que é a chave da
   * janela de re-declaração: a mesma linha é reescrita a cada leitura enquanto
   * estiver dentro da janela, e é assim que uma conversão que chega em D+9
   * atribuída a D entra na série. A unique existe na tabela particionada porque
   * contém a chave de partição (`date`) — sem isso, `ON CONFLICT` não seria
   * expressável e a re-declaração viraria linha duplicada.
   */
  private async writeBatch(rows: AdMetricUpsert[]): Promise<void> {
    if (rows.length === 0) return;

    const values: unknown[] = [];
    const tuples: string[] = [];

    for (const row of rows) {
      const start = values.length;
      values.push(
        randomUUID(),
        row.adId,
        row.organizationId,
        row.adAccountId,
        row.platform,
        row.date,
        'DAY',
        row.campaignId,
        row.adSetId,
        row.creativeId,
        row.spend,
        row.impressions,
        row.clicks,
        row.conversions,
        row.revenue,
        row.reach,
        row.frequency,
        row.videoViews,
        row.engagement,
        row.thumbstopRate,
        row.holdRate,
        row.hides,
        row.hideAllFor,
        row.reports,
        row.unlikes,
        row.currency,
        row.baseCurrency,
        row.spendBase,
        row.revenueBase,
        row.fxRate,
        row.fxAsOf,
        row.fxSource,
        row.normalizationPending,
        row.accountTimezone,
        row.attributionSetting,
        row.syncedAt,
      );

      // Os dois enums precisam de cast explícito: o driver manda `text`, e o
      // Postgres não converte para tipo enumerado por conta própria.
      const placeholders = COLUMNS.map((column, offset) => {
        const parameter = `$${start + offset + 1}`;
        if (column === 'platform') return `${parameter}::"Platform"`;
        if (column === 'granularity')
          return `${parameter}::"MetricGranularity"`;
        return parameter;
      });

      tuples.push(`(${placeholders.join(', ')})`);
    }

    const assignments = UPDATED_COLUMNS.map(
      (column) => `"${column}" = EXCLUDED."${column}"`,
    ).join(', ');

    const sql =
      `INSERT INTO "ad_metric_snapshots" (${COLUMNS.map((c) => `"${c}"`).join(', ')}) ` +
      `VALUES ${tuples.join(', ')} ` +
      `ON CONFLICT ("ad_id", "date", "granularity") DO UPDATE SET ${assignments}`;

    await this.prisma.$executeRawUnsafe(sql, ...values);
  }

  async latestDateByAd(adIds: string[]): Promise<Map<string, Date>> {
    if (adIds.length === 0) return new Map();

    const groups = await this.prisma.adMetricSnapshot.groupBy({
      by: ['adId'],
      where: { adId: { in: adIds } },
      _max: { date: true },
    });

    return new Map(
      groups
        .filter((group) => group._max.date !== null)
        .map((group) => [group.adId, group._max.date as Date]),
    );
  }
}
