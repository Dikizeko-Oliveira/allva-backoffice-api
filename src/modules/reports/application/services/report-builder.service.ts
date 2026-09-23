import { Injectable } from '@nestjs/common';
import { AdsRepositoryInterface } from 'src/modules/ads/domain/ports/ads.repository';
import { RecommendationsRepositoryInterface } from 'src/modules/recommendations/domain/ports/recommendations.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { MEASUREMENT_VERSION } from 'src/modules/recommendations/domain/outcome-measurement';
import { RECOMMENDATION_ENGINE_VERSION } from 'src/modules/recommendations/domain/contracts/engine-version';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { AnalyticsAggregatorService } from 'src/modules/analytics/application/services/analytics-aggregator.service';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { WasteSettingsReader } from 'src/modules/waste/domain/ports/waste-settings.reader';
import { ReportDocument } from 'src/modules/reports/infrastructure/pdf/pdf-renderer.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';
import {
  formatDateBR,
  formatDateTimeBR,
  formatInteger,
  formatMoneyAmount,
  formatMoneyView,
  formatNumber,
  formatPercent,
} from 'src/shared/domain/formatters';

/**
 * Os quatro templates, **reescritos sobre `Ad`** em A2-S9 (entrega 4).
 *
 * O v1 agregava `metric_snapshots` por plataforma e chamava aquilo de relatório
 * de performance. A v2.0 relata o que o produto de fato afirma: quais anúncios
 * queimam dinheiro, quanto dá para interromper hoje, e o que aconteceu com o que
 * já foi corrigido.
 *
 * **Todo documento carrega procedência e `asOf`** (P7). Um PDF sai da Allva e
 * vira anexo de e-mail; sem a janela, a versão do motor e o instante da leitura,
 * ele é um número sem contexto sendo lido semanas depois como se fosse de hoje.
 */

/**
 * Os nomes são os **mesmos títulos que cada documento imprime** — antes eram os
 * únicos quatro rótulos em inglês de um produto que fala português, e o catálogo
 * dizia "Weekly Performance" enquanto o PDF baixado dizia "Performance semanal".
 * O e-mail de entrega também os usa; ali o que saía era o `templateKey` cru.
 */
export const REPORT_TEMPLATES = [
  {
    key: 'weekly-performance',
    name: 'Performance semanal',
    description:
      'Os anúncios que mais queimam, ordenados pelo que dá para interromper hoje.',
  },
  {
    key: 'creative-analysis',
    name: 'Análise criativa',
    description:
      'Score, confiança e cobertura por anúncio, com os criativos de pior desempenho.',
  },
  {
    key: 'waste-report',
    name: 'Relatório de desperdício',
    description:
      'Desperdício aberto: par de grandezas, prioridade, tipo e rollup por campanha.',
  },
  {
    key: 'executive-summary',
    name: 'Resumo executivo',
    // Sem `**`: esta string é rótulo de catálogo, lida direto pelo card da tela,
    // que não interpreta markdown - os asteriscos apareciam no card.
    description:
      'Desperdício, recomendações e impacto medido — os três tipos separados.',
  },
  {
    key: 'period-performance',
    name: 'Desempenho por período',
    description:
      'Gasto, receita, ROAS e CPA no período que você escolher, contra o período anterior.',
  },
] as const;

/**
 * O único modelo cujo período é **escolhido**, e a razão da exceção.
 *
 * Os outros quatro relatam diagnóstico — score, desperdício, impacto medido —,
 * e diagnóstico só existe na janela em que foi calculado: pedir "o desperdício
 * dos últimos 90 dias" não é um recorte diferente, é um cálculo que nunca
 * aconteceu. Este relata **somas** de `ad_metric_snapshots`: gasto, receita,
 * cliques. Uma soma é recortável por qualquer intervalo que ainda esteja no
 * banco, e é isso que torna 90, 180 ou 365 dias uma pergunta legítima aqui e
 * sem sentido lá.
 *
 * O v1 tinha um relatório que somava `metric_snapshots` e se chamava
 * "performance". Ele saiu na v2.0 porque o nome prometia diagnóstico e entregava
 * contabilidade. Este volta com o nome do que faz, e diz no próprio corpo o que
 * não é.
 */
export const PERIOD_SCOPED_TEMPLATE = 'period-performance';

/** Os períodos oferecidos, antes do piso de histórico do plano. */
export const PERIOD_OPTIONS_DAYS = [30, 90, 180, 365] as const;

export const MIN_PERIOD_DAYS = 7;
export const MAX_PERIOD_DAYS = 365;
export const DEFAULT_PERIOD_DAYS = 30;

export function isPeriodScoped(templateKey: string): boolean {
  return templateKey === PERIOD_SCOPED_TEMPLATE;
}

export type ReportTemplateKey = (typeof REPORT_TEMPLATES)[number]['key'];

/** Quantas linhas cabem numa tabela de PDF sem virar listagem. */
const TOP_N = 20;

@Injectable()
export class ReportBuilderService {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly waste: WasteReadRepositoryInterface,
    private readonly recommendations: RecommendationsRepositoryInterface,
    private readonly settings: WasteSettingsReader,
    private readonly metrics: AdMetricsRepositoryInterface,
    private readonly aggregator: AnalyticsAggregatorService,
    private readonly planEntitlement: PlanEntitlementService,
  ) {}

  isValidTemplate(key: string): key is ReportTemplateKey {
    return REPORT_TEMPLATES.some((t) => t.key === key);
  }

  async build(
    templateKey: ReportTemplateKey,
    scope: { accountId: string; organizationId?: string | null },
    /**
     * Só `periodDays` é lido, e só pelo modelo de período. Os demais ignoram
     * este argumento por construção: a janela deles não é escolha de quem gera
     * (veja a nota logo abaixo, em `build`).
     */
    params?: Record<string, unknown> | null,
  ): Promise<ReportDocument> {
    /**
     * **Relatório é sempre de uma organização** (§16.7, P2).
     *
     * O v1 aceitava escopo de conta porque a v1 não tinha organização
     * obrigatória. Gerar sem ela leria a base inteira do tenant errado — e um
     * PDF é a forma mais fácil de vazamento sair da aplicação sem ninguém ver.
     */
    if (!scope.organizationId) {
      throw new DomainError({
        code: 'ORGANIZATION_REQUIRED',
        category: 'NOT_PERMITTED',
        message: 'Selecione uma organização para gerar relatórios.',
        remediation: 'Envie o header X-Organization-Id de uma organização sua.',
      });
    }

    const organizationId = scope.organizationId;

    /**
     * **A janela é lida, não recebida** (P7).
     *
     * Até aqui ela vinha de `params.windowDays`, com 14 no lugar do que não
     * fosse enviado — e nenhuma consulta deste arquivo filtra por ela. As
     * colunas monetárias de `ads` são materializadas pelo scoring na janela
     * ativa da organização, e `waste.summary`/`rollup` só usam o número para
     * contar itens de *outra* janela (DEC-11). Um `windowDays: 30` produzia um
     * PDF que **declarava** 30 dias sobre números de 14: a procedência, que
     * existe para o documento não ser lido fora de contexto, passava a ser a
     * própria fonte do engano.
     *
     * `WasteSettingsReader` é a mesma fonte que a listagem de desperdício e a
     * Visão Geral declaram - o relatório passa a dizer o que os números são.
     */
    if (templateKey === PERIOD_SCOPED_TEMPLATE) {
      return this.periodPerformance(
        organizationId,
        clampPeriodDays(Number(params?.periodDays ?? DEFAULT_PERIOD_DAYS)),
      );
    }

    const { windowDays } = await this.settings.forOrganization(organizationId);

    switch (templateKey) {
      case 'weekly-performance':
        return this.weeklyPerformance(organizationId, windowDays);
      case 'creative-analysis':
        return this.creativeAnalysis(organizationId, windowDays);
      case 'waste-report':
        return this.wasteReport(organizationId, windowDays);
      case 'executive-summary':
        return this.executiveSummary(organizationId, windowDays);
    }
  }

  /**
   * A tela principal em PDF: os anúncios ordenados por `avoidableDaily`.
   *
   * A ordenação é a mesma de `GET /ads` e pela mesma razão (§7.1): rankear pelo
   * que já foi perdido põe no topo o anúncio sobre o qual não há mais o que
   * fazer.
   */
  private async weeklyPerformance(
    organizationId: string,
    windowDays: number,
  ): Promise<ReportDocument> {
    const [list, summary] = await Promise.all([
      this.ads.list({
        organizationId,
        sortBy: 'avoidableDaily',
        sortDirection: 'desc',
        limit: TOP_N,
      }),
      this.waste.summary({ organizationId, windowDays }),
    ]);

    return {
      title: 'Performance semanal',
      subtitle: `Janela de ${windowDays} dias`,
      generatedAt: new Date(),
      sections: [
        provenanceSection({ windowDays, asOf: summary.asOf }),
        {
          heading: 'Onde o dinheiro está indo',
          bullets: [
            `Anúncios com desperdício aberto: ${formatInteger(summary.affectedAds)}`,
            `Achados abertos: ${formatInteger(summary.openCount)}`,
            `Já incorrido: ${formatMoneyView(summary.incurred)}`,
            `Evitável por dia: ${formatMoneyView(summary.avoidableDaily)}`,
          ],
        },
        {
          heading: `Top ${TOP_N} por evitável diário`,
          table: {
            columns: [
              'Anúncio',
              'Plataforma',
              'Score',
              'Conf.',
              'Evitável/dia',
              'Incorrido',
            ],
            columnWidths: [3, 1.4, 1, 1, 1.4, 1.4],
            rows: list.items.map((ad) => [
              ad.name,
              ad.platform,
              formatNumber(ad.score.value),
              formatNumber(ad.score.confidence),
              formatMoneyView(ad.waste.avoidableDaily),
              formatMoneyView(ad.waste.openAmount),
            ]),
          },
        },
        excludedSection(list.excludedByFloor),
      ],
    };
  }

  /**
   * Score por anúncio, **com confiança e cobertura ao lado** (D11).
   *
   * Nunca o score sozinho: 38 sem a confiança convida a decisão que a confiança
   * desaconselha, e a cobertura é o que explica por que ela caiu numa plataforma
   * que não entrega metade dos sinais.
   */
  private async creativeAnalysis(
    organizationId: string,
    windowDays: number,
  ): Promise<ReportDocument> {
    const list = await this.ads.list({
      organizationId,
      sortBy: 'aiScore',
      sortDirection: 'asc',
      limit: TOP_N,
    });

    return {
      title: 'Análise criativa',
      subtitle: `Janela de ${windowDays} dias`,
      generatedAt: new Date(),
      sections: [
        provenanceSection({
          windowDays,
          asOf: list.items.at(0)?.score.asOf ?? null,
        }),
        {
          heading: `Os ${TOP_N} anúncios de menor score`,
          table: {
            columns: [
              'Anúncio',
              'Criativo',
              'Score',
              'Confiança',
              'Cobertura',
              'Δ 7d',
            ],
            columnWidths: [2.6, 1.6, 1, 1, 1, 1],
            rows: list.items.map((ad) => [
              ad.name,
              ad.creative?.id ?? '—',
              formatNumber(ad.score.value),
              formatNumber(ad.score.confidence),
              formatNumber(ad.score.coverage),
              // `null` é "não há delta a reportar", não "delta zero": a série
              // atravessou uma descontinuidade (§12.5).
              formatNumber(ad.score.delta7d),
            ]),
          },
        },
        excludedSection(list.excludedByFloor),
      ],
    };
  }

  private async wasteReport(
    organizationId: string,
    windowDays: number,
  ): Promise<ReportDocument> {
    const [summary, rollup] = await Promise.all([
      this.waste.summary({ organizationId, windowDays }),
      this.waste.rollup({
        organizationId,
        groupBy: 'campaign',
        windowDays,
        limit: TOP_N,
      }),
    ]);

    return {
      title: 'Relatório de desperdício',
      subtitle: `Janela de ${windowDays} dias`,
      generatedAt: new Date(),
      sections: [
        provenanceSection({ windowDays, asOf: summary.asOf }),
        {
          heading: 'O par de grandezas (§10.1)',
          paragraphs: [
            'O incorrido responde "quanto já queimei com este problema". O ' +
              'evitável diário responde "quanto queimo por dia se não fizer ' +
              'nada" — e é o único comparável com o impacto medido depois.',
          ],
          bullets: [
            `Já incorrido: ${formatMoneyView(summary.incurred)}`,
            `Evitável por dia: ${formatMoneyView(summary.avoidableDaily)}`,
            `Anúncios afetados: ${formatInteger(summary.affectedAds)}`,
          ],
        },
        {
          heading: 'Por prioridade',
          bullets: Object.entries(summary.byPriority).map(
            ([priority, count]) => `${priority}: ${formatInteger(count)}`,
          ),
        },
        {
          heading: 'Por tipo de achado',
          bullets: Object.entries(summary.byType).map(
            ([type, count]) => `${type}: ${formatInteger(count)}`,
          ),
        },
        {
          heading: 'Rollup por campanha',
          paragraphs: [
            'Um anúncio com três achados abertos contribui **uma vez** — a ' +
              'subconsulta é pré-agregada por anúncio (§10.8).',
          ],
          table: {
            columns: [
              'Campanha',
              'Anúncios',
              'Aberto (base)',
              'Evitável/dia',
              'Críticos',
            ],
            columnWidths: [2.4, 1, 1.4, 1.4, 1],
            rows: rollup.rows.map((row) => [
              row.groupName,
              formatInteger(row.affectedAds),
              formatMoneyAmount(row.openWasteBase, rollup.baseCurrency),
              formatMoneyAmount(row.avoidableDailyBase, rollup.baseCurrency),
              formatInteger(row.criticalItems),
            ]),
          },
        },
      ],
    };
  }

  /**
   * Contabilidade do período, e **nada de diagnóstico**.
   *
   * Soma `ad_metric_snapshots` no intervalo pedido e compara com o intervalo
   * imediatamente anterior de mesmo comprimento — a mesma leitura da Visão
   * Geral, com o mesmo agregador, para os dois não divergirem por terem
   * reimplementado a média em lugares diferentes.
   *
   * **O piso de histórico do plano é declarado, nunca aplicado em silêncio**
   * (mesma conduta de `ad-read-use-cases`): um relatório de 365 dias que só
   * pôde ler 90 e não diz isso é lido como o ano inteiro, e quem o lê conclui
   * queda onde houve limite comercial.
   */
  private async periodPerformance(
    organizationId: string,
    periodDays: number,
  ): Promise<ReportDocument> {
    const now = new Date();
    const until = now;
    const requested = daysBefore(now, periodDays);

    const floor = await this.planEntitlement.historyFloorFor(organizationId);
    const truncated = floor !== null && floor > requested;
    const since = truncated ? floor : requested;

    // O comparativo pede um intervalo do mesmo comprimento **efetivo** — usar o
    // pedido depois de truncar compararia 90 dias com os 365 anteriores.
    const effectiveDays = daysBetween(since, until);
    const previousSince = daysBefore(since, effectiveDays);

    const [current, previous] = await Promise.all([
      this.metrics.query({ organizationId, since, until }),
      this.metrics.query({
        organizationId,
        since: previousSince,
        until: since,
      }),
    ]);

    const totals = this.aggregator.totals(current);
    const totalsPrev = this.aggregator.totals(previous);
    const byPlatform = this.aggregator.byPlatform(current);
    const currency = totals.currency ?? '—';

    const delta = (a: number | null, b: number | null): string => {
      if (a === null || b === null) return '—';
      return formatPercent(this.aggregator.delta(a, b), { signed: true });
    };

    return {
      title: 'Desempenho por período',
      subtitle: `${effectiveDays} dias · ${formatDateBR(since)} a ${formatDateBR(until)}`,
      generatedAt: now,
      sections: [
        {
          heading: 'Procedência',
          bullets: [
            `Período: ${effectiveDays} dias (${formatDateBR(since)} a ${formatDateBR(until)})`,
            `Comparado com: ${formatDateBR(previousSince)} a ${formatDateBR(since)}`,
            `Moeda-base: ${currency}`,
            ...(truncated
              ? [
                  `**Pedido de ${periodDays} dias truncado para ${effectiveDays}**: o ` +
                    'histórico legível do plano começa em ' +
                    `${formatDateBR(since)}. O dado anterior continua guardado.`,
                ]
              : []),
            ...(totals.excludedPendingNormalization > 0
              ? [
                  `${totals.excludedPendingNormalization} linha(s) ficaram fora dos ` +
                    'totais por não terem taxa de câmbio do dia na ingestão (M1).',
                ]
              : []),
          ],
        },
        {
          heading: 'O que este relatório é, e o que não é',
          paragraphs: [
            'São **somas** do que as plataformas reportaram no período: gasto, ' +
              'receita, impressões, cliques e conversões, convertidos para a ' +
              'moeda-base. Servem para responder quanto saiu e quanto voltou.',
            '**Não há diagnóstico aqui** — nenhum score, desperdício ou ' +
              'recomendação. Esses são calculados sobre a janela de análise da ' +
              'organização e não existem para um período arbitrário do passado; ' +
              'para eles, use os outros modelos.',
          ],
        },
        {
          heading: 'Totais do período',
          table: {
            columns: ['Métrica', 'Período', 'Período anterior', 'Variação'],
            columnWidths: [1.6, 1.4, 1.4, 1],
            rows: [
              [
                'Gasto',
                formatMoneyAmount(totals.spend, totals.currency),
                formatMoneyAmount(totalsPrev.spend, totalsPrev.currency),
                delta(totals.spend, totalsPrev.spend),
              ],
              [
                'Receita',
                formatMoneyAmount(totals.revenue, totals.currency),
                formatMoneyAmount(totalsPrev.revenue, totalsPrev.currency),
                delta(totals.revenue, totalsPrev.revenue),
              ],
              [
                'Conversões',
                formatInteger(totals.conversions),
                formatInteger(totalsPrev.conversions),
                delta(totals.conversions, totalsPrev.conversions),
              ],
              [
                'ROAS',
                formatNumber(totals.roas),
                formatNumber(totalsPrev.roas),
                delta(totals.roas, totalsPrev.roas),
              ],
              [
                'CPA',
                formatNumber(totals.cpa),
                formatNumber(totalsPrev.cpa),
                delta(totals.cpa, totalsPrev.cpa),
              ],
              [
                'CTR (%)',
                formatNumber(totals.ctr),
                formatNumber(totalsPrev.ctr),
                delta(totals.ctr, totalsPrev.ctr),
              ],
              [
                'CPC',
                formatNumber(totals.cpc),
                formatNumber(totalsPrev.cpc),
                delta(totals.cpc, totalsPrev.cpc),
              ],
            ],
          },
        },
        {
          heading: 'Por plataforma',
          ...(Object.keys(byPlatform).length === 0
            ? {
                bullets: [
                  'Nenhuma linha de métrica no período — nada a distribuir por plataforma.',
                ],
              }
            : {
                table: {
                  columns: [
                    'Plataforma',
                    'Gasto',
                    'Receita',
                    'Conversões',
                    'ROAS',
                    'CPA',
                  ],
                  rows: Object.entries(byPlatform).map(([platform, t]) => [
                    platform,
                    formatMoneyAmount(t.spend, t.currency),
                    formatMoneyAmount(t.revenue, t.currency),
                    formatInteger(t.conversions),
                    formatNumber(t.roas),
                    formatNumber(t.cpa),
                  ]),
                },
              }),
        },
      ],
    };
  }

  /**
   * O resumo executivo — e o primeiro relatório da história do produto que
   * reporta **impacto medido**, não impacto estimado.
   *
   * Os três tipos aparecem separados e nunca somados (§9.7). O medido é rotulado
   * `observedDelta`: é medição pré/pós, não atribuição causal, e o relatório diz
   * isso em vez de deixar o leitor supor.
   */
  private async executiveSummary(
    organizationId: string,
    windowDays: number,
  ): Promise<ReportDocument> {
    const [summary, impact] = await Promise.all([
      this.waste.summary({ organizationId, windowDays }),
      this.recommendations.impactSummary(organizationId),
    ]);

    return {
      title: 'Resumo executivo',
      subtitle: `Janela de ${windowDays} dias · moeda-base ${impact.baseCurrency}`,
      generatedAt: new Date(),
      sections: [
        provenanceSection({ windowDays, asOf: summary.asOf }),
        {
          heading: 'Desperdício aberto',
          bullets: [
            `Já incorrido: ${formatMoneyView(summary.incurred)}`,
            `Evitável por dia: ${formatMoneyView(summary.avoidableDaily)}`,
            `Anúncios afetados: ${formatInteger(summary.affectedAds)}`,
          ],
        },
        {
          heading: 'Impacto por tipo — nunca somados',
          paragraphs: [
            'Economia, ganho de eficiência e receita adicional têm naturezas e ' +
              'confianças diferentes. Somá-los produziria um número de capa ' +
              'cuja maior parcela é a menos confiável.',
          ],
          table: {
            columns: [
              'Tipo',
              'Estimado (aberto)',
              'Estimado (aplicado)',
              'observedDelta',
              'Medidas',
            ],
            columnWidths: [1.6, 1.4, 1.4, 1.4, 1],
            rows: impact.byType.map((row) => [
              row.type,
              formatMoneyAmount(row.openEstimatedBase, impact.baseCurrency),
              formatMoneyAmount(row.appliedEstimatedBase, impact.baseCurrency),
              formatMoneyAmount(row.observedDeltaBase, impact.baseCurrency),
              formatInteger(row.measuredCount),
            ]),
          },
        },
        {
          heading: 'O que o número medido é, e o que não é',
          paragraphs: [
            '`observedDelta` é a diferença entre a janela anterior e a ' +
              'posterior à aplicação, convertidas pela mesma taxa de câmbio. ' +
              '**Não é atribuição causal**: o orçamento pode ter migrado para ' +
              'outro anúncio, e a sazonalidade pode ter mudado o leilão.',
          ],
          bullets: [
            `Medições concluídas: ${formatInteger(impact.measurement.measured)}`,
            `Aguardando janela: ${formatInteger(impact.measurement.pending)}`,
            `Abandonadas por falta de série: ${formatInteger(impact.measurement.abandoned)}`,
            `Com confounder declarado: ${formatInteger(impact.measurement.withConfounders)}`,
            `Versões de medição no recorte: ${
              impact.measurement.versions.join(', ') || '—'
            }`,
            `Consultivas fora das métricas de acurácia: ${formatInteger(impact.advisoryExcluded)}`,
          ],
        },
      ],
    };
  }
}

/** P7 em toda página: versão, janela e instante da leitura. */
function provenanceSection(input: { windowDays: number; asOf: Date | null }) {
  return {
    heading: 'Procedência',
    bullets: [
      `Janela: ${input.windowDays} dias`,
      `Dados de: ${input.asOf ? formatDateTimeBR(input.asOf) : 'sem leitura registrada'}`,
      `Motor de recomendação: ${RECOMMENDATION_ENGINE_VERSION}`,
      `Motor de medição: ${MEASUREMENT_VERSION}`,
    ],
  };
}

/**
 * §12.4 — **quantos ficaram de fora, e não só que houve exclusão**.
 *
 * "Alguns itens foram omitidos" é informação que ninguém consegue usar. "3 de
 * 240 ficaram fora por confiança abaixo do piso" é — o leitor decide se
 * investiga ou ignora.
 */
function excludedSection(excludedByFloor: number) {
  return {
    heading: 'Exclusões declaradas',
    bullets: [
      excludedByFloor > 0
        ? `${excludedByFloor} anúncio(s) ficaram fora da ordenação por confiança abaixo do piso de §12.4.`
        : 'Nenhum anúncio ficou fora da ordenação pelos pisos de confiança.',
    ],
  };
}

export function clampPeriodDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_PERIOD_DAYS;
  return Math.min(Math.max(Math.round(days), MIN_PERIOD_DAYS), MAX_PERIOD_DAYS);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysBefore(date: Date, days: number): Date {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

function daysBetween(since: Date, until: Date): number {
  return Math.max(
    1,
    Math.round((until.getTime() - since.getTime()) / MS_PER_DAY),
  );
}
