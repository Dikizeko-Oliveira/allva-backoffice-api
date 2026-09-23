import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AD_SORT_SPECS,
  sortKeyFor,
} from 'src/modules/ads/domain/ad-list-sorting';
import {
  AdListQuery,
  AdSortField,
  AdsRepositoryInterface,
} from 'src/modules/ads/domain/ports/ads.repository';
import {
  Section,
  sectionEmpty,
  sectionOk,
  sectionPending,
  sectionUnavailable,
} from 'src/modules/ads/domain/read-models/ad-views';
import { ListAdsQueryDto } from 'src/modules/ads/application/dtos/list-ads-query.dto';
import { breaksSeries } from 'src/modules/ads/domain/series-discontinuity';
import { platformCoverageMaxFor } from 'src/modules/ad-scoring/domain/contracts/score-model';
import {
  decodeCursor,
  encodeCursor,
} from 'src/shared/infrastructure/http/pagination/cursor';
import { resolveLimit } from 'src/shared/infrastructure/http/pagination/page-query.dto';
import { envelope } from 'src/shared/infrastructure/http/envelope/response-meta';
import { PlanEntitlementService } from 'src/modules/plans/application/plan-entitlement.service';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { DomainError } from 'src/shared/infrastructure/http/errors/domain-error';

const DEFAULT_SORT: AdSortField = 'avoidableDaily';
/** Janela padrão de série, alinhada ao `scoringWindowDays` default (D8). */
const DEFAULT_SERIES_DAYS = 14;

/**
 * Guarda comum às leituras ads-first.
 *
 * `ADS_FIRST_READ_ENABLED` é o interruptor de rollout de §14.7: a superfície
 * inteira nasce atrás dele para que um problema de desempenho na tela principal
 * seja um `false` em produção, não um deploy de emergência.
 */
function assertReadEnabled(env: EnvService): void {
  if (env.get('ADS_FIRST_READ_ENABLED')) return;

  throw new DomainError({
    code: 'ADS_FIRST_READ_DISABLED',
    category: 'PRECONDITION_FAILED',
    message: 'A superfície ads-first está desligada nesta instalação.',
    remediation:
      'Ligue ADS_FIRST_READ_ENABLED para habilitar as rotas de /ads.',
  });
}

@Injectable()
export class ListAdsUseCase {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, query: ListAdsQueryDto) {
    assertReadEnabled(this.env);

    const sortBy = query.sortBy ?? DEFAULT_SORT;
    const sortDirection =
      query.sortDirection ?? AD_SORT_SPECS[sortBy].defaultDirection;
    const sort = sortKeyFor(sortBy, sortDirection);
    const limit = resolveLimit(query.limit);

    // O cursor carrega a ordenação sob a qual foi emitido: trocar de ordenação
    // no meio da paginação recusa, em vez de continuar de uma posição que era
    // de outra lista.
    const cursor = query.cursor ? decodeCursor(query.cursor, sort) : undefined;

    const result = await this.ads.list({
      ...this.toFilters(query),
      organizationId,
      sortBy,
      sortDirection,
      limit,
      cursor: cursor ? { keys: cursor.keys, id: cursor.id } : undefined,
    } satisfies AdListQuery);

    // O repositório já cortou a linha extra; aqui só se emite o cursor para a
    // última entregue, sob a ordenação em que ela foi ordenada.
    const last = result.items.at(-1);
    const nextCursor =
      result.hasMore && last
        ? encodeCursor({ sort, keys: [last.id], id: last.id })
        : null;

    return envelope(result.items, {
      asOf: new Date().toISOString(),
      provenance: {
        // A janela é declarada, não filtrada (D20): a denormalização é sempre da
        // janela ativa da organização e não tem dimensão de janela.
        windowDays: DEFAULT_SERIES_DAYS,
        // **Quantos** ficaram fora, não só que ficaram (§12.4). O rótulo
        // `PARTIAL` diz que houve omissão; o número é o que permite ao usuário
        // decidir se ela importa.
        ...(result.excludedByFloor > 0
          ? { excludedByScoreFloor: result.excludedByFloor }
          : {}),
      },
      page: { hasMore: result.hasMore, nextCursor },
      // §12.2: a comparabilidade entre plataformas é preservada por declaração,
      // não por exclusão. Sem isto, cobertura 0,45 no Search (o teto possível) e
      // 0,45 no Meta (metade do sinal perdida) apareceriam idênticas.
      coverageByPlatform: coverageByPlatformOf(result.items),
      ...(result.excludedByFloor > 0
        ? { evidenceSufficiency: 'PARTIAL' as const }
        : {}),
    });
  }

  private toFilters(query: ListAdsQueryDto) {
    return {
      platform: query.platform,
      adAccountId: query.adAccountId,
      campaignId: query.campaignId,
      adSetId: query.adSetId,
      creativeId: query.creativeId,
      status: query.status,
      syncState: query.syncState,
      archived: query.archived,
      hasOpenWaste: query.hasOpenWaste,
      hasOpenOpportunity: query.hasOpenOpportunity,
      minWasteAmountBase: query.minWasteAmountBase,
      scoreBelow: query.scoreBelow,
      scoreDroppedBy: query.scoreDroppedBy,
      confidenceAbove: query.confidenceAbove,
      dataMaturity: query.dataMaturity,
      lineageId: query.lineageId,
    };
  }
}

@Injectable()
export class GetAdUseCase {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, adId: string) {
    assertReadEnabled(this.env);

    const ad = await this.ads.findDetail(organizationId, adId);
    if (!ad) throw new NotFoundException('Anúncio não encontrado');

    const lineage = await this.ads.lineageMembers(
      organizationId,
      ad.lineage.lineageId,
    );

    return envelope(
      { ...ad, lineage: { ...ad.lineage, members: lineage } },
      {
        asOf: (ad.observedAsOf ?? ad.firstSeenAt).toISOString(),
        dataMaturity: ad.dataMaturity ?? undefined,
        provenance: { windowDays: DEFAULT_SERIES_DAYS },
      },
    );
  }
}

/** `YYYY-MM-DD` — a fronteira é um dia, não um instante. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

@Injectable()
export class GetAdSeriesUseCase {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly env: EnvService,
  ) {}

  async execute(
    organizationId: string,
    adId: string,
    options: { days?: number; followLineage?: boolean },
  ) {
    assertReadEnabled(this.env);

    const ad = await this.ads.findRef(organizationId, adId);
    if (!ad) throw new NotFoundException('Anúncio não encontrado');

    const days = options.days ?? DEFAULT_SERIES_DAYS;
    const until = new Date();
    const requested = new Date(until.getTime() - days * 24 * 60 * 60 * 1000);

    /**
     * O piso de histórico do plano corta a janela pedida, e o corte é
     * **declarado**.
     *
     * O dado não some — a retenção é global e o Profissional lê os mesmos 13
     * meses de sempre. O que o plano governa é até onde a leitura alcança. E
     * cortar em silêncio faria a série truncada ser lida como a série real: o
     * usuário concluiria queda de desempenho onde houve limite comercial.
     */
    const floor = await this.planEntitlement.historyFloorFor(organizationId);
    const truncated = floor !== null && floor > requested;
    const since = truncated ? floor : requested;

    const series = await this.ads.series({
      organizationId,
      adId,
      since,
      until,
      // Padrão `true` (§7.1): recriar o anúncio é evento nosso, não do usuário.
      followLineage: options.followLineage ?? true,
    });

    // Conta pontos por onde a série **não** pode ser lida (§12.5). Valor fora do
    // vocabulário não conta: uma string desconhecida cortaria a série inteira
    // por causa de um typo, e a evidência é declarada degradada, não perdida.
    const discontinuities = series.filter((point) =>
      breaksSeries(point.seriesDiscontinuity),
    ).length;

    return envelope(series, {
      asOf: until.toISOString(),
      dataMaturity: undefined,
      provenance: {
        windowDays: truncated
          ? Math.max(
              0,
              Math.round((until.getTime() - since.getTime()) / 86_400_000),
            )
          : days,
        ...(truncated ? { historyTruncatedAt: isoDay(since) } : {}),
      },
      ...(discontinuities > 0
        ? { evidenceSufficiency: 'PARTIAL' as const }
        : {}),
    });
  }
}

@Injectable()
export class GetAdHistoryUseCase {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly planEntitlement: PlanEntitlementService,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, adId: string, followLineage = true) {
    assertReadEnabled(this.env);

    const ad = await this.ads.findRef(organizationId, adId);
    if (!ad) throw new NotFoundException('Anúncio não encontrado');

    const entries = await this.ads.history(organizationId, adId, followLineage);

    /**
     * O corte acontece aqui e não no repositório de propósito.
     *
     * A linha do tempo é curta — dezenas de entradas, não milhares — e empurrar
     * a data para o port obrigaria todo chamador a conhecer o piso de plano,
     * inclusive os jobs que não têm plano nenhum. Filtrar depois de ler custa
     * nada e mantém a regra comercial fora do contrato de leitura do agregado.
     */
    const floor = await this.planEntitlement.historyFloorFor(organizationId);
    const visible = floor
      ? entries.filter((entry) => entry.at >= floor)
      : entries;

    const truncated = visible.length < entries.length;

    return envelope(visible, {
      asOf: new Date().toISOString(),
      provenance: {
        ...(truncated && floor ? { historyTruncatedAt: isoDay(floor) } : {}),
      },
    });
  }
}

/**
 * `GET /ads/{id}/analysis` — **estado por seção, sempre `200`** (§7.5).
 *
 * O contrato nasceu em A2-S2 com quase toda seção em `PENDING` e o sprint que a
 * preencheria, e isso **era** o contrato definitivo: o mesmo shape passa a
 * trazer `OK` quando o motor existe. A2-S9 fecha a última — `creativeAnalysis`
 * respondia `PENDING` citando A2-S4 **depois** de A2-S4 ter entregue as regras
 * e de A2-S9 ter entregue a rota que as executa.
 *
 * > Uma seção que diz `PENDING` sobre algo que existe é pior que uma seção
 * > ausente: o cliente aprende a ignorá-la, e continua ignorando quando ela
 * > passa a trazer dado.
 */
@Injectable()
export class GetAdAnalysisUseCase {
  constructor(
    private readonly ads: AdsRepositoryInterface,
    private readonly env: EnvService,
  ) {}

  async execute(organizationId: string, adId: string) {
    assertReadEnabled(this.env);

    const ad = await this.ads.findDetail(organizationId, adId);
    if (!ad) throw new NotFoundException('Anúncio não encontrado');

    const score: Section<unknown> = ad.score.value
      ? sectionOk({
          aiScore: ad.score.value,
          confidence: ad.score.confidence,
          coverage: ad.score.coverage,
          delta7d: ad.score.delta7d,
          scoredAt: ad.score.asOf,
        })
      : /**
         * **`PENDING` continua certo aqui, e o texto não.** O score é produto
         * de ciclo diário: ele *chega sozinho*, então prometer que chega é
         * honesto. Citar "A2-S4" como futuro deixou de ser — o sprint entregou,
         * e o motivo real de não haver score é outro.
         */
        sectionPending(
          'O ciclo de scoring ainda não visitou este anúncio, ou a série é curta demais.',
        );

    return envelope(
      {
        ad: {
          id: ad.id,
          lineageId: ad.lineageId,
          name: ad.name,
          platform: ad.platform,
          externalAdId: ad.externalAdId,
          unitKind: ad.unitKind,
          observedStatus: ad.observedStatus,
          desiredStatus: ad.desiredStatus,
          syncState: ad.syncState,
          campaign: ad.campaign,
          adSet: ad.adSet,
          creative: ad.creative,
        },
        score,
        /**
         * **`UNAVAILABLE`, não `PENDING`** — e a distinção é o conserto.
         *
         * `PENDING` promete que o dado chega sozinho; a análise do par
         * `(Creative, Ad)` é **sob demanda** (`POST /ads/{id}/analyze`) e não
         * produto de ciclo, então ela nunca chegaria. Até A2-S9 esta linha dizia
         * "entra em A2-S4" — dois sprints depois de A2-S4.
         *
         * **`ads` não lê a análise, e não é omissão.** Servir o conteúdo aqui
         * exigiria injetar um port de `creative-lab`, e `creative-lab` depende de
         * `ad-scoring`, que depende de `ads`: o grafo de §5.3 se fecharia em
         * ciclo. `ads` é a base porque não conhece ninguém — a rota que produz a
         * análise devolve a análise, e é lá que ela mora.
         */
        /**
         * **O `reason` é lido pelo usuário, não pelo cliente HTTP.** Ele dizia
         * `POST /ads/{id}/analyze`: o endpoint não é acionável por quem está na
         * tela, e a única pergunta que a frase precisa responder — "então onde
         * consigo essa análise?" — ficava sem resposta. O porquê técnico
         * continua no comentário acima, que é onde ele serve a alguém.
         */
        creativeAnalysis: sectionUnavailable(
          'A análise deste criativo neste anúncio é feita sob demanda. ' +
            'Abra o criativo no Laboratório Criativo e clique em "Analisar".',
        ),
        // **`wasteAsOf` é o que separa "não há" de "não olhamos".** Sem ele,
        // contagem zero seria apresentada como anúncio saudável em um anúncio
        // que o detector nunca visitou — a lista vazia lida como ausência de
        // problema, que é o erro que §7.5 existe para impedir.
        openWaste: ad.waste.asOf
          ? ad.waste.openCount > 0
            ? sectionOk({
                count: ad.waste.openCount,
                incurred: ad.waste.openAmount,
                avoidableDaily: ad.waste.avoidableDaily,
                asOf: ad.waste.asOf,
              })
            : sectionEmpty('Nenhum desperdício aberto na última varredura.')
          : sectionPending('O detector ainda não visitou este anúncio.'),
        // `ads` não guarda denormalização de oportunidade — as colunas de §5.4
        // são do grupo `waste` e carregam o `max` sobre achados `WASTE` (§10.6).
        // Declarar onde o dado está é honesto; inventar uma contagem a partir da
        // coluna errada faria a tela somar oportunidade com desperdício.
        opportunities: sectionUnavailable(
          'Oportunidades são servidas por GET /waste/opportunities?adId=.',
        ),
        /**
         * **Onde o dado mora, nunca uma contagem.** "Nenhuma recomendação
         * ativa" seria uma afirmação sobre os dados do usuário feita por quem
         * não os leu — e lista vazia lida como ausência de problema é o erro
         * que §7.5 existe para impedir. `ads` não conhece `recommendations`
         * (§5.3 r.1); a rota que as serve, sim.
         */
        recommendations: sectionUnavailable(
          'Recomendações são servidas por GET /ads/{id}/recommendations.',
        ),
      },
      {
        asOf: (ad.observedAsOf ?? ad.firstSeenAt).toISOString(),
        dataMaturity: ad.dataMaturity ?? undefined,
        provenance: { windowDays: DEFAULT_SERIES_DAYS },
        evidenceSufficiency: ad.score.value ? 'SUFFICIENT' : 'MISSING_SCORE',
      },
    );
  }
}

/**
 * O teto de cobertura de cada plataforma presente na página.
 *
 * Derivado do `PlatformProfile`, sem consulta: é configuração declarativa, e
 * calculá-lo aqui evita uma coluna a mais em `ads` para um número que não muda
 * por anúncio.
 */
function coverageByPlatformOf(
  items: Array<{ platform: string }>,
): Record<string, number> {
  const platforms = [...new Set(items.map((item) => item.platform))];

  return Object.fromEntries(
    platforms.map((platform) => [
      platform,
      platformCoverageMaxFor(
        platform as Parameters<typeof platformCoverageMaxFor>[0],
      ),
    ]),
  );
}
