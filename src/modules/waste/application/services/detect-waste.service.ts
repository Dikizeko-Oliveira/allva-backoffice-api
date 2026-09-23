import { Injectable, Logger } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { AdScoreReader } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import { DomainEventBus } from 'src/shared/domain/events/domain-event-bus';
import { JobContext } from 'src/shared/domain/events/job-context';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { buildBaseline } from 'src/modules/waste/domain/baseline';
import type { Baseline } from 'src/modules/waste/domain/detection-context';
import { requiredMaturity } from 'src/modules/waste/domain/evidence';
import {
  maturityLagDays,
  type DataMaturity,
} from 'src/modules/sync/domain/data-maturity';
import type { Finding } from 'src/modules/waste/domain/detection-context';
import {
  AD_SCOPED_DETECTORS,
  AD_SET_SCOPED_DETECTORS,
  runAdDetector,
  runAdSetDetector,
} from 'src/modules/waste/domain/detectors';
import { fingerprintOf } from 'src/modules/waste/domain/fingerprint';
import {
  decideResolution,
  isRestatement,
  supersededByDetector,
} from 'src/modules/waste/domain/resolution';
import { rollupForAd } from 'src/modules/waste/domain/summability';
import {
  WasteItemsRepositoryInterface,
  type AdWasteDenormalization,
  type OpenWasteItem,
  type WasteItemWrite,
  type WasteResolutionWrite,
} from 'src/modules/waste/domain/ports/waste-items.repository';
import {
  WasteTargetsRepositoryInterface,
  type DetectableAd,
} from 'src/modules/waste/domain/ports/waste-targets.repository';
import type { DetectorProfile } from 'src/modules/waste/domain/detector-profile';
import {
  aggregateAdWindow,
  peersOf,
} from 'src/modules/waste/domain/window-aggregate';
import type {
  AdWindowAggregate,
  Insufficiency,
} from 'src/modules/waste/domain/detection-context';
import { benchmarkKeyOf, peerGroupKeyOf } from 'src/modules/ads/domain/ad-unit';
import {
  natureOf,
  summarizeEvidenceGaps,
  type EvidenceGap,
  type SlicedInsufficiency,
} from 'src/modules/waste/domain/evidence-gaps';

export type DetectionOutcomeSummary = {
  adAccountId: string;
  adsEvaluated: number;
  findings: number;
  created: number;
  resolved: number;
  /** Itens que ficaram abertos por falta de observação válida. */
  keptStale: number;
  /** Recusas por falta de dado — o que o tempo resolve. */
  insufficient: number;
  /**
   * Recusas porque o detector não se aplica ao anúncio (objetivo que não é
   * conversão, evento não contável, componente que o formato não produz).
   * Separadas de `insufficient` para ele continuar significando "falta dado".
   */
  notApplicable: number;
  /** Preenchido quando §8.7 ou §10.7 passo 1 pausaram o ciclo. */
  blockedReason: string | null;
};

/**
 * O ciclo de detecção de §10.7 — os nove passos, nesta ordem.
 *
 * Faz I/O e orquestra; **nenhuma decisão sobre o número mora aqui**. Limiar,
 * benchmark, evidência mínima, atribuição, somabilidade e classificação de
 * resolução são funções puras em `domain/`, e é por isso que cada uma delas tem
 * teste sem container.
 *
 * A guarda do passo 1 e a do passo 7 são a mesma ideia aplicada duas vezes:
 * **ausência de dado nunca é evidência**. Sem elas, uma integração fora do ar
 * por uma noite resolveria todo o desperdício aberto da organização como
 * "condição cessou", e o produto reportaria na manhã seguinte um dia
 * excepcionalmente bom, produzido inteiramente pela própria cegueira.
 */
@Injectable()
export class DetectWasteService {
  private readonly logger = new Logger(DetectWasteService.name);

  constructor(
    private readonly targets: WasteTargetsRepositoryInterface,
    private readonly metrics: AdMetricsRepositoryInterface,
    private readonly items: WasteItemsRepositoryInterface,
    private readonly scores: AdScoreReader,
    private readonly events: DomainEventBus,
    private readonly env: EnvService,
  ) {}

  async execute(input: {
    adAccountId: string;
    ctx: JobContext;
    now?: Date;
  }): Promise<DetectionOutcomeSummary> {
    const now = input.now ?? new Date();
    const settings = await this.targets.settingsForAccount(input.adAccountId);

    if (!settings) {
      throw new Error(`AdAccount ${input.adAccountId} não encontrada`);
    }

    const outcome: DetectionOutcomeSummary = {
      adAccountId: input.adAccountId,
      adsEvaluated: 0,
      findings: 0,
      created: 0,
      resolved: 0,
      keptStale: 0,
      insufficient: 0,
      notApplicable: 0,
      blockedReason: null,
    };

    if (!settings.detectionAllowed) {
      outcome.blockedReason = settings.detectionBlockedReason;
      return outcome;
    }

    const ads = await this.targets.listDetectable(input.adAccountId);
    if (ads.length === 0) return outcome;

    const open = await this.items.openItemsFor({
      organizationId: settings.organizationId,
      adIds: ads.map((ad) => ad.id),
    });

    // §10.7 passo 1. **Encerra sem detectar E SEM RESOLVER NADA.** Os itens
    // abertos continuam abertos e passam a se declarar velhos — o que é
    // diferente de continuarem calados, porque a tela precisa distinguir "isto
    // ainda é verdade" de "isto é o que sabíamos antes de a leitura falhar".
    if (!settings.hasValidObservation) {
      outcome.blockedReason = 'NO_VALID_OBSERVATION';
      outcome.keptStale = await this.items.markStaleObservation({
        ids: open.map((item) => item.id),
        stale: true,
      });
      this.logger.warn(
        `waste.detection_skipped adAccountId=${input.adAccountId} ` +
          `motivo=NO_VALID_OBSERVATION abertos_marcados=${outcome.keptStale}`,
      );
      return outcome;
    }

    const profile = await this.targets.profileFor(
      settings.organizationId,
      settings.activeDetectorProfileVersion,
    );

    /**
     * **Uma leitura, vários recortes** (§8.9, correção do portão de maturidade).
     *
     * Cada classe de maturidade julga uma janela que termina antes dos dias
     * ainda em re-declaração — é isso que faz o portão perguntar "esta janela
     * assentou?" em vez de "o dado mais novo deste anúncio assentou?", que num
     * anúncio ativo nunca assentava.
     *
     * A leitura é a mais larga de todas e os recortes saem em memória: três
     * consultas ao banco pelo mesmo período seria triplicar a I/O do passo mais
     * caro do ciclo para obter linhas que a primeira já trouxe.
     */
    const attributionDays = settings.attributionWindowDays;
    const classes = maturityClassesFor(profile);
    const widestLag = Math.max(
      ...classes.map((c) => maturityLagDays(c, attributionDays ?? undefined)),
    );

    const readWindow = detectionWindow(now, settings.windowDays + widestLag);
    const rows = await this.metrics.query({
      organizationId: settings.organizationId,
      adIds: ads.map((ad) => ad.id),
      since: readWindow.since,
      until: readWindow.until,
    });

    const rowsByAd = groupBy(rows, (row) => row.adId);
    const scoreByAd = await this.scores.currentByAdIds(
      settings.organizationId,
      ads.map((ad) => ad.id),
    );

    const gate = {
      maturityGatingEnabled: this.env.get('DATA_MATURITY_GATING_ENABLED'),
    };

    /**
     * O contexto inteiro por classe — agregados, pares e linha de base.
     *
     * Fatiar só o anúncio julgado e comparar contra pares de outro período
     * produziria um veredito sobre janelas diferentes: a comparação de CTR é
     * inteiramente relativa a esses pares, e a de CPA à mediana da conta.
     */
    const contexts = new Map<DataMaturity, DetectionSlice>();

    for (const required of classes) {
      const lag = maturityLagDays(required, attributionDays ?? undefined);
      const window = detectionWindow(now, settings.windowDays, lag);

      const aggregates = ads.map((ad) =>
        aggregateAdWindow({
          ad,
          // Comparação por **dia**, não por instante: as fronteiras da janela
          // são meia-noite UTC e as linhas carregam a hora da leitura, então
          // comparar timestamps cru derrubaria o dia da borda.
          rows: (rowsByAd.get(ad.id) ?? []).filter((row) => {
            const day = utcDay(row.date).getTime();
            return (
              day >= window.since.getTime() && day <= window.until.getTime()
            );
          }),
          baseCurrency: settings.baseCurrency,
          hasValidObservation: true,
          now,
          attributionWindowDays: attributionDays,
        }),
      );

      // §10.7 passo 3. A linha de base da conta usa só quem **entrega e tem
      // dado**: incluir pausados compara desempenho de agora com o de quem
      // parou semanas atrás, e é assim que uma conta em férias vira uma conta
      // doente.
      const live = aggregates.filter((ad) => ad.isDelivering && ad.days > 0);

      contexts.set(required, {
        aggregates,
        lagDays: lag,
        adsById: new Map(aggregates.map((ad) => [ad.adId, ad])),
        byAdSet: groupBy(aggregates, (ad) => ad.adSetId ?? ''),
        byPeerGroup: groupBy(aggregates, (ad) => peerGroupKeyOf(ad)),
        accountBaseline: buildBaseline(live),
        // E só **entre iguais**: a mediana de CPA junta quem conta o mesmo
        // evento (lead com lead, compra com compra), e a de CTR junta quem
        // busca o mesmo resultado. Sem isso, o CPA de lead entrava na régua
        // do CPA de compra e o CTR de alcance na do anúncio de venda. O grupo
        // de recursos tem régua própria pelo mesmo motivo (D23).
        baselineBySegment: new Map(
          [...groupBy(live, (ad) => benchmarkKeyOf(ad))].map(
            ([segment, ads]) => [segment, buildBaseline(ads)],
          ),
        ),
      });
    }

    /**
     * O recorte sem defasagem é o retrato **corrente** da conta.
     *
     * É dele que saem a denormalização e a gravação dos achados: as duas
     * descrevem o que a conta é hoje, não o período que cada detector julgou.
     */
    const base = contexts.get('IMMATURE')!;
    const { adsById } = base;

    const findings: Finding[] = [];
    const recusals = new Map<string, SlicedInsufficiency[]>();
    const recordRecusal = (insufficiency: Insufficiency, lagDays: number) => {
      if (natureOf(insufficiency.code) === 'NOT_APPLICABLE') {
        outcome.notApplicable += 1;
      } else {
        outcome.insufficient += 1;
      }
      const list = recusals.get(insufficiency.adId) ?? [];
      list.push({ ...insufficiency, lagDays });
      recusals.set(insufficiency.adId, list);
    };

    // §10.7 passo 4 — família `AD`, cada detector no recorte da sua classe.
    outcome.adsEvaluated += base.aggregates.length;

    for (const detector of AD_SCOPED_DETECTORS) {
      const slice = contexts.get(requiredMaturity(detector.type, profile))!;

      for (const ad of slice.aggregates) {
        const result = runAdDetector(
          detector,
          {
            ad,
            adSetPeers: peersOf(ad, slice.byPeerGroup),
            accountBaseline: baselineFor(slice, ad),
            score: scoreByAd.get(ad.adId) ?? null,
            windowDays: settings.windowDays,
            profile,
          },
          gate,
        );

        if (result.finding) findings.push(result.finding);
        if (result.insufficiency) {
          recordRecusal(result.insufficiency, slice.lagDays);
        }
      }
    }

    // §10.7 passo 5 — família `AD_SET`, com atribuição determinística.
    for (const detector of AD_SET_SCOPED_DETECTORS) {
      const slice = contexts.get(requiredMaturity(detector.type, profile))!;

      for (const [adSetId, setAds] of slice.byAdSet) {
        if (!adSetId) continue;

        const results = runAdSetDetector(
          detector,
          {
            adSetId,
            ads: setAds,
            scores: scopedScores(scoreByAd, setAds),
            // O conjunto compartilha a otimização: o segmento de qualquer um
            // dos anúncios é o de todos.
            accountBaseline: baselineFor(slice, setAds[0]),
            windowDays: settings.windowDays,
            profile,
          },
          slice.adsById,
          gate,
        );

        for (const result of results) {
          if (result.finding) findings.push(result.finding);
          if (result.insufficiency) {
            recordRecusal(result.insufficiency, slice.lagDays);
          }
        }
      }
    }

    outcome.findings = findings.length;

    const detected = new Map(
      findings.map((finding) => [
        fingerprintOf(finding.adId, finding.type),
        finding,
      ]),
    );

    // §10.4 — **só mudança de lógica supersede.** Roda antes do upsert porque o
    // índice parcial `waste_items_open_unique` admite um aberto por fingerprint:
    // fechar o item da versão antiga é o que libera o slot para o novo.
    const superseded = open.filter((item) =>
      supersededByDetector({
        itemDetectorVersion: item.detectorVersion,
        currentDetectorVersion:
          detected.get(item.fingerprint)?.detectorVersion ??
          item.detectorVersion,
      }),
    );

    if (superseded.length > 0) {
      outcome.resolved += await this.items.resolveMany(
        superseded.map((item) => ({
          id: item.id,
          kind: 'SUPERSEDED_BY_DETECTOR' as const,
          resolvedAt: now,
        })),
      );
    }

    const supersededIds = new Set(superseded.map((item) => item.id));

    // §10.7 passo 6.
    const writes = findings.map((finding) =>
      this.toWrite(finding, settings, profile, adsById.get(finding.adId)),
    );
    const upserts = await this.items.upsertMany(writes, now);
    outcome.created = upserts.filter((result) => result.created).length;

    // §10.7 passo 7 — auto-resolve, **somente** para achados cujo ad teve
    // observação válida.
    const resolutions = this.autoResolve({
      open: open.filter((item) => !supersededIds.has(item.id)),
      detected,
      adsById,
      adsByIdRaw: new Map(ads.map((ad) => [ad.id, ad])),
      now,
    });

    if (resolutions.length > 0) {
      outcome.resolved += await this.items.resolveMany(resolutions);
    }

    // Nenhum item ficou velho: houve observação válida, e o passo 7 já decidiu
    // sobre cada um. Limpar a marca é o que impede um item de carregar para
    // sempre um aviso de uma noite de indisponibilidade.
    const stillOpen = open
      .filter((item) => !supersededIds.has(item.id))
      .filter(
        (item) => !resolutions.some((resolution) => resolution.id === item.id),
      );

    if (stillOpen.length > 0) {
      await this.items.markStaleObservation({
        ids: stillOpen.map((item) => item.id),
        stale: false,
      });
    }

    // §10.7 passo 8 — com o que ficou sem julgamento, e por quê.
    const firstObservedByAd = new Map(
      [...rowsByAd].map(([adId, adRows]) => [
        adId,
        adRows.reduce<Date | null>(
          (first, row) =>
            first === null || row.date < first ? row.date : first,
          null,
        ),
      ]),
    );

    const gapsByAd = new Map(
      base.aggregates.map((ad) => [
        ad.adId,
        // Pausado não acumula evidência: dizer "falta X" a quem não entrega
        // sugeriria esperar por algo que não vem.
        ad.isDelivering
          ? summarizeEvidenceGaps({
              insufficiencies: recusals.get(ad.adId) ?? [],
              recent: ad,
              firstObservedOn: firstObservedByAd.get(ad.adId) ?? null,
              windowDays: settings.windowDays,
              now,
            })
          : null,
      ]),
    );

    await this.items.denormalizeIntoAds(
      this.denormalizations(findings, base.aggregates, now, gapsByAd),
    );

    // §10.7 passo 9.
    const emit = { ...input.ctx, organizationId: settings.organizationId };
    for (const upsert of upserts) {
      const finding = detected.get(upsert.fingerprint);
      if (!finding) continue;

      this.events.emitFrom(emit, 'waste.detected', {
        adId: finding.adId,
        wasteItemId: upsert.id,
        type: finding.type,
        kind: finding.kind,
        incurred: {
          value: finding.incurred.value,
          currency: finding.currency,
          valueBase: finding.incurred.valueBase,
          baseCurrency: finding.baseCurrency,
        },
        avoidableDaily: {
          value: finding.avoidableDaily.value,
          currency: finding.currency,
          valueBase: finding.avoidableDaily.valueBase,
          baseCurrency: finding.baseCurrency,
        },
        priority: finding.priority,
      });
    }

    for (const resolution of resolutions) {
      const item = open.find((candidate) => candidate.id === resolution.id);
      if (!item) continue;

      this.events.emitFrom(emit, 'waste.resolved', {
        adId: item.adId,
        wasteItemId: item.id,
        resolutionKind: resolution.kind,
      });
    }

    this.logger.log(
      `waste.detected adAccountId=${input.adAccountId} achados=${outcome.findings} ` +
        `novos=${outcome.created} resolvidos=${outcome.resolved} ` +
        `insuficientes=${outcome.insufficient} nao_aplicaveis=${outcome.notApplicable}`,
    );

    return outcome;
  }

  /**
   * O passo 7 como classificação pura, item a item.
   *
   * Redetectado não passa por aqui — ele foi atualizado pelo upsert, e um item
   * que continua sendo detectado nunca está sendo resolvido.
   */
  private autoResolve(input: {
    open: OpenWasteItem[];
    detected: Map<string, Finding>;
    adsById: Map<string, AdWindowAggregate>;
    adsByIdRaw: Map<string, DetectableAd>;
    now: Date;
  }): WasteResolutionWrite[] {
    const resolutions: WasteResolutionWrite[] = [];

    for (const item of input.open) {
      if (input.detected.has(item.fingerprint)) continue;

      const aggregate = input.adsById.get(item.adId);
      const raw = input.adsByIdRaw.get(item.adId);
      if (!aggregate || !raw) continue;

      const decision = decideResolution({
        observation: {
          valid: aggregate.hasValidObservation,
          adArchived: raw.archivedAt !== null,
        },
        restated: isRestatement({
          previousObserved: item.observed,
          currentObserved: {
            spendBase: aggregate.spendBase,
            conversions: aggregate.conversions,
            revenueBase: aggregate.revenueBase,
          },
        }),
      });

      if (decision.action === 'RESOLVE') {
        resolutions.push({
          id: item.id,
          kind: decision.kind,
          resolvedAt: input.now,
        });
      }
    }

    return resolutions;
  }

  /**
   * `detectorProfileVersion` vem do perfil **de fato aplicado**, nunca do que a
   * organização pediu.
   *
   * `profileFor` cai para o padrão global quando o perfil persistido é ilegível
   * e devolve a versão padrão junto. Gravar aqui a versão pedida quebraria a
   * resposta a "por que este anúncio foi marcado?" exatamente no caso em que ela
   * importa — o do perfil que não foi usado.
   */
  private toWrite(
    finding: Finding,
    settings: { organizationId: string; accountId: string; windowDays: number },
    profile: DetectorProfile,
    ad: AdWindowAggregate | undefined,
  ): WasteItemWrite {
    return {
      adId: finding.adId,
      organizationId: settings.organizationId,
      accountId: settings.accountId,
      creativeId: ad?.creativeId ?? null,
      findingKind: finding.kind,
      type: finding.type,
      priority: finding.priority,
      windowDays: settings.windowDays,
      incurredAmount: finding.incurred.value,
      incurredAmountBase: finding.incurred.valueBase,
      avoidableDailyAmount: finding.avoidableDaily.value,
      avoidableDailyBase: finding.avoidableDaily.valueBase,
      currency: finding.currency,
      baseCurrency: finding.baseCurrency,
      diagnosis: finding.diagnosis,
      evidence: finding.evidence,
      evidenceSufficiency: finding.evidenceSufficiency,
      scopeLevel: finding.scopeLevel,
      dataMaturity: finding.dataMaturity,
      detectorVersion: finding.detectorVersion,
      detectorProfileVersion: profile.version,
      fingerprint: fingerprintOf(finding.adId, finding.type),
    };
  }

  /**
   * §10.6 — o `max` por anúncio, nunca a soma entre tipos.
   *
   * Um anúncio com `ZERO_CONVERSIONS` e `LOW_CTR` desperdiçou **um** gasto, não
   * dois; e pausá-lo resolve os dois de uma vez, que é por que o evitável também
   * é máximo. São essas colunas — e somente elas — que os rollups somam.
   *
   * Todo anúncio avaliado entra na lista, inclusive os **sem achado**: sem isso,
   * o anúncio que deixou de ter desperdício continuaria carregando o número da
   * última vez que teve, e a tela mostraria dinheiro queimando num anúncio limpo.
   */
  private denormalizations(
    findings: Finding[],
    aggregates: AdWindowAggregate[],
    now: Date,
    gapsByAd: Map<string, EvidenceGap[] | null>,
  ): AdWasteDenormalization[] {
    const byAd = groupBy(findings, (finding) => finding.adId);

    return aggregates.map((ad) => {
      const rollup = rollupForAd(byAd.get(ad.adId) ?? []);

      return {
        adId: ad.adId,
        openWasteCount: rollup.openWasteCount,
        openWasteAmount: rollup.incurred.value,
        openWasteAmountBase: rollup.incurred.valueBase,
        openWasteCurrency: rollup.openWasteCount > 0 ? ad.currency : null,
        avoidableDailyAmountBase: rollup.avoidableDaily.valueBase,
        wasteAsOf: now,
        evidenceGaps: gapsByAd.get(ad.adId) ?? null,
      };
    });
  }
}

/** O contexto completo de uma classe de maturidade. */
type DetectionSlice = {
  aggregates: AdWindowAggregate[];
  /** Quanto a janela julgada recua de hoje — vai para a estimativa das lacunas. */
  lagDays: number;
  adsById: Map<string, AdWindowAggregate>;
  /** Só conjuntos reais — é sobre eles que a família `AD_SET` julga. */
  byAdSet: Map<string, AdWindowAggregate[]>;
  /** Conjunto, ou campanha para a unidade sem conjunto — os pares da família `AD`. */
  byPeerGroup: Map<string, AdWindowAggregate[]>;
  /** A conta inteira — mantida para leitura; os detectores usam a segmentada. */
  accountBaseline: Baseline;
  baselineBySegment: Map<string, Baseline>;
};

const EMPTY_BASELINE: Baseline = buildBaseline([]);

/** A linha de base dos anúncios com o mesmo objetivo e evento do anúncio julgado. */
function baselineFor(
  slice: DetectionSlice,
  ad: AdWindowAggregate | undefined,
): Baseline {
  if (!ad) return EMPTY_BASELINE;
  return slice.baselineBySegment.get(benchmarkKeyOf(ad)) ?? EMPTY_BASELINE;
}

/**
 * As classes de maturidade em uso, `IMMATURE` sempre incluída.
 *
 * `IMMATURE` é o recorte sem defasagem — o que responde pelos detectores que
 * não exigem maturidade e o que alimenta a denormalização, que descreve o
 * presente da conta e não o período julgado.
 */
function maturityClassesFor(profile: DetectorProfile): DataMaturity[] {
  const required = new Set<DataMaturity>(['IMMATURE']);

  for (const detector of [...AD_SCOPED_DETECTORS, ...AD_SET_SCOPED_DETECTORS]) {
    required.add(requiredMaturity(detector.type, profile));
  }

  return [...required];
}

/**
 * A janela julgada, recuada pela defasagem da classe de maturidade.
 *
 * `lagDays` é o que separa "esta janela assentou" de "o dado mais novo deste
 * anúncio assentou". Zero para os detectores que não exigem maturidade — para
 * eles a janela continua terminando hoje, que é o mais acionável.
 */
function detectionWindow(
  now: Date,
  days: number,
  lagDays = 0,
): { since: Date; until: Date } {
  const until = utcDay(now);
  until.setUTCDate(until.getUTCDate() - Math.max(0, lagDays));

  const since = new Date(until);
  since.setUTCDate(since.getUTCDate() - Math.max(1, days) + 1);
  return { since, until };
}

function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function scopedScores(
  all: Map<string, AdScoreView>,
  ads: AdWindowAggregate[],
): Map<string, AdScoreView> {
  const scoped = new Map<string, AdScoreView>();
  for (const ad of ads) {
    const score = all.get(ad.adId);
    if (score) scoped.set(ad.adId, score);
  }
  return scoped;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const item of items) {
    const bucket = grouped.get(key(item)) ?? [];
    bucket.push(item);
    grouped.set(key(item), bucket);
  }
  return grouped;
}
