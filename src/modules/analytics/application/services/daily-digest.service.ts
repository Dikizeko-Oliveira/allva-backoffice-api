import { Injectable, Logger } from '@nestjs/common';
import { AdMetricsRepositoryInterface } from 'src/modules/ads/domain/ports/ad-metrics.repository';
import { WasteReadRepositoryInterface } from 'src/modules/waste/domain/ports/waste-read.repository';
import { AiDecisionLogRepositoryInterface } from 'src/modules/ai/domain/ports/ai-decision-log.repository';
import { DailyDigestRepositoryInterface } from 'src/modules/analytics/domain/ports/daily-digest.repository';
import { DailyDigestNarrator } from 'src/modules/analytics/domain/ports/daily-digest.narrator';
import {
  deterministicSummary,
  digestOf,
  type DigestFacts,
} from 'src/modules/analytics/domain/daily-digest';
import { AnalyticsAggregatorService } from './analytics-aggregator.service';

const DIGEST_WINDOW_DAYS = 7;

/** O dia em UTC, sem hora — a chave de "uma vez ao dia". */
function utcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/**
 * Produz o resumo diário de uma organização.
 *
 * **Nunca é chamado por leitura de tela.** O card lê a linha gravada; se não
 * houver a do dia, ele diz que ainda não há — como qualquer seção de §7.5. Foi
 * essa a exigência: a IA não pode entrar em ação porque alguém deu refresh.
 *
 * A economia acontece em **três degraus**, do mais barato ao mais caro:
 *
 * 1. **Já existe resumo para hoje?** Sai sem calcular nada. É o que torna o
 *    reenfileiramento inofensivo.
 * 2. **O digest dos fatos mudou?** Se não, copia o texto de ontem e registra
 *    `SKIPPED_DIGEST` — zero token. Conta parada nunca gasta.
 * 3. **Só então** a narração é pedida, e ela ainda passa pelo teto de custo
 *    diário da organização (C9) antes de sair.
 */
@Injectable()
export class DailyDigestService {
  private readonly logger = new Logger(DailyDigestService.name);

  constructor(
    private readonly digests: DailyDigestRepositoryInterface,
    private readonly snapshots: AdMetricsRepositoryInterface,
    private readonly waste: WasteReadRepositoryInterface,
    private readonly aggregator: AnalyticsAggregatorService,
    private readonly narrator: DailyDigestNarrator,
    private readonly decisions: AiDecisionLogRepositoryInterface,
  ) {}

  async generateFor(input: {
    organizationId: string;
    correlationId?: string | null;
    now?: Date;
  }): Promise<{ outcome: 'CREATED' | 'REUSED' | 'ALREADY_DONE' }> {
    const now = input.now ?? new Date();
    const digestDate = utcDay(now);

    // Degrau 1 — o mais barato de todos: já rodou hoje.
    const existing = await this.digests.findByDate({
      organizationId: input.organizationId,
      digestDate,
    });

    if (existing) return { outcome: 'ALREADY_DONE' };

    const facts = await this.computeFacts({
      organizationId: input.organizationId,
      now,
    });
    const inputDigest = digestOf(facts);

    // Degrau 2 — os fatos são os mesmos de ontem: o texto de ontem continua
    // verdadeiro, e chamar o provider para reescrevê-lo seria gastar por nada.
    const previous = await this.digests.latestFor(input.organizationId);

    if (previous && previous.inputDigest === inputDigest) {
      await this.digests.save({
        organizationId: input.organizationId,
        digestDate,
        inputDigest,
        facts,
        narrative: previous.narrative,
        enrichedByAI: previous.enrichedByAI,
        promptVersion: previous.promptVersion,
        reusedFromDate: previous.reusedFromDate ?? previous.digestDate,
      });

      // A economia é registrada: sem esta linha, "o texto é igual ao de ontem"
      // e "o job não rodou" seriam indistinguíveis para quem investiga.
      await this.decisions.record({
        organizationId: input.organizationId,
        taskType: 'DAILY_DIGEST',
        provider: 'none',
        model: 'none',
        promptVersion: previous.promptVersion ?? 'none',
        outcome: 'SKIPPED_DIGEST',
        fallbackUsed: false,
        inputDigest,
        promptHash: inputDigest,
        correlationId: input.correlationId ?? null,
      });

      this.logger.debug(
        `digest.reused organizationId=${input.organizationId} digest=${inputDigest.slice(0, 12)}`,
      );

      return { outcome: 'REUSED' };
    }

    // Degrau 3 — os fatos mudaram. Só aqui a IA é acionada, e ainda sujeita ao
    // teto de custo diário, que o narrador avalia antes de chamar o provider.
    const narration = await this.narrator.narrate({
      organizationId: input.organizationId,
      facts,
      inputDigest,
      correlationId: input.correlationId ?? null,
    });

    await this.digests.save({
      organizationId: input.organizationId,
      digestDate,
      inputDigest,
      facts,
      // P4: sem IA, o resumo determinístico **é** a resposta — não um aviso de
      // indisponibilidade. O card não sabe a diferença, e não precisa saber.
      narrative: narration.narrative ?? deterministicSummary(facts),
      enrichedByAI: narration.narrative !== null,
      promptVersion: narration.promptVersion,
      reusedFromDate: null,
    });

    return { outcome: 'CREATED' };
  }

  /**
   * Os fatos — determinísticos, e calculados antes de qualquer IA.
   *
   * A janela é de 7 dias porque o resumo é diário: comparar 30 dias contra 30
   * faria a variação diluir a ponto de o texto dizer a mesma coisa toda semana.
   */
  private async computeFacts(input: {
    organizationId: string;
    now: Date;
  }): Promise<DigestFacts> {
    const dayMs = 24 * 60 * 60 * 1000;
    const until = input.now;
    const since = new Date(until.getTime() - DIGEST_WINDOW_DAYS * dayMs);
    const previousSince = new Date(
      since.getTime() - DIGEST_WINDOW_DAYS * dayMs,
    );

    const [current, previous, wasteSummary] = await Promise.all([
      // Escopo só por organização: `accountId` existe para a leitura por
      // usuário autenticado, e num job agendado não há usuário. Resolver um
      // "dono" para preencher o campo estreitaria o recorte sem motivo.
      this.snapshots.query({
        organizationId: input.organizationId,
        since,
        until,
      }),
      this.snapshots.query({
        organizationId: input.organizationId,
        since: previousSince,
        until: since,
      }),
      this.waste.summary({
        organizationId: input.organizationId,
        windowDays: DIGEST_WINDOW_DAYS,
      }),
    ]);

    const totals = this.aggregator.totals(current);
    const previousTotals = this.aggregator.totals(previous);

    return {
      periodDays: DIGEST_WINDOW_DAYS,
      baseCurrency: totals.currency,
      spendBase: totals.spend,
      revenueBase: totals.revenue,
      roas: totals.roas,
      spendDelta: this.aggregator.delta(totals.spend, previousTotals.spend),
      roasDelta:
        totals.roas !== null && previousTotals.roas !== null
          ? this.aggregator.delta(totals.roas, previousTotals.roas)
          : null,
      openWasteCount: wasteSummary.openCount,
      affectedAds: wasteSummary.affectedAds,
      avoidableDailyBase: wasteSummary.avoidableDaily?.valueBase ?? null,
      // O ritmo entra como fato quando houver — o card de pacing já o calcula,
      // e duplicar a consulta aqui só para o texto seria pagar duas vezes.
      pacingStatus: null,
    };
  }
}
