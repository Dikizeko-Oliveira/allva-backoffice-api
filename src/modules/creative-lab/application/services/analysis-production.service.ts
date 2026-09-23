import { Injectable } from '@nestjs/common';
import type { AdScoreView } from 'src/modules/ad-scoring/domain/ports/ad-score-reader.port';
import { compareAdsOfCreative } from 'src/modules/creative-lab/domain/cross-ad-dispersion';
import { suggestCopyChanges } from 'src/modules/creative-lab/domain/creative-suggestions';
import { resolveCandidates } from 'src/modules/creative-lab/domain/creative-candidates';
import { CreativeAnalysisRepositoryInterface } from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import type { AnalysisSubject } from 'src/modules/creative-lab/domain/ports/creative-analysis.repository';
import { AnalysisEnrichmentService } from 'src/modules/creative-lab/application/services/analysis-enrichment.service';
import { presentAnalysis } from 'src/modules/creative-lab/application/presenters/creative-analysis.presenter';

/** A versão do motor de análise, na procedência de toda resposta (P7). */
export const CREATIVE_ANALYSIS_ENGINE_VERSION = 'creative-v2.0.0';

export type ProduceAnalysisInput = {
  input: { organizationId: string; adId: string };
  subject: AnalysisSubject;
  score: AdScoreView;
  startedAt: Date;
  aiReadingIncludedInPlan: boolean;
  quota: { limit: number | null; used: number };
};

/**
 * A versão nova da análise — tudo que acontece **depois** de a cota reservada.
 *
 * ## Por que é um serviço, e não o resto do caso de uso
 *
 * Porque é exatamente o trecho que a devolução de cota protege. Com ele dentro
 * de `execute`, o `try/catch` teria de abraçar o fluxo inteiro — e uma falha de
 * leitura de anúncio, que acontece **antes** da reserva, devolveria uma unidade
 * que ninguém tirou. Uma fronteira de método é o que torna "o que foi
 * reservado" e "o que pode falhar" o mesmo bloco.
 *
 * O caso de uso fica com o que lhe cabe: resolver plano, anúncio e score,
 * decidir reuso, reservar, e apresentar. §16.6 cobra ~150 linhas por use case,
 * e o número é o sintoma — a divisão acima é a razão.
 *
 * **Determinístico até a última linha** (P4): comparação e candidatos são
 * funções puras, e a narrativa é enriquecimento por cima de um diagnóstico que
 * já está inteiro.
 */
@Injectable()
export class AnalysisProductionService {
  constructor(
    private readonly analyses: CreativeAnalysisRepositoryInterface,
    private readonly enrichment: AnalysisEnrichmentService,
  ) {}

  async produce(ctx: ProduceAnalysisInput) {
    const { input, subject, score, startedAt } = ctx;

    const [siblings, candidatePool] = await Promise.all([
      this.analyses.adsOfCreative({
        organizationId: input.organizationId,
        creativeId: subject.creativeId,
      }),
      this.analyses.candidatesFor({
        organizationId: input.organizationId,
        adAccountId: subject.adAccountId,
      }),
    ]);

    const comparison = compareAdsOfCreative(siblings);

    /**
     * §11.4 passo 5 — **as sugestões, antes de qualquer IA**.
     *
     * `score.components` já chega na forma que a regra pede: as cinco leituras
     * com `available`, `normalizedValue` e `confidence`. Um mapeador aqui só
     * criaria um segundo lugar onde a escala pode ser interpretada errado.
     *
     * O veredito entra porque ele pode **reter** a sugestão inteira:
     * `AUDIENCE_MISMATCH` diz que a peça funciona e o público de um anúncio é
     * que está errado — reescrever a copy consertaria o que não está quebrado.
     */
    const suggestions = suggestCopyChanges({
      components: score.components,
      verdict: comparison.verdict,
      copy: subject.copy,
    });

    const candidates = resolveCandidates({
      fatiguedContentHash: subject.contentHash,
      targetAdSetId: subject.adSetId,
      candidates: candidatePool,
      now: startedAt,
    });

    /**
     * **A narrativa vem depois do diagnóstico, e é a ordem que P4 exige.**
     *
     * O que é persistido abaixo já está inteiro: dispersão, veredito,
     * candidatos. O texto é campo a mais, e `null` quando o provider cai, o
     * orçamento estoura ou não há veredito a explicar.
     */
    const narrative = await this.enrichment.enrich({
      request: {
        organizationId: input.organizationId,
        adId: input.adId,
        adName: subject.adName,
        platform: subject.platform,
        aiScore: score.aiScore,
        aiConfidence: score.aiConfidence,
        comparison,
        candidates,
      },
      inputDigest: subject.metricsDigest,
      correlationId: null,
    });

    const stored = await this.analyses.persist({
      organizationId: input.organizationId,
      accountId: subject.accountId,
      adId: input.adId,
      creativeId: subject.creativeId,
      adScoreId: score.adScoreId,
      metricsDigest: subject.metricsDigest,
      trigger: 'MANUAL',
      engineVersion: CREATIVE_ANALYSIS_ENGINE_VERSION,
      diagnostics: {
        schemaVersion: 1,
        dispersion: comparison.dispersion,
        verdict: comparison.verdict,
        comparedAdIds: comparison.compared.map((ad) => ad.adId),
        // Reportado, nunca omitido (P7): quem ficou de fora e por quê é a
        // diferença entre "não há dispersão" e "não olhamos o suficiente".
        excluded: comparison.excluded,
        // O texto mora junto do que ele explica: uma coluna própria criaria
        // duas casas para o mesmo conteúdo, e elas divergiriam na primeira
        // remensuração offline.
        narrative: narrative.narrative,
      },
      candidates,
      suggestions,
      narrative: narrative.narrative,
      aiProvider: narrative.provider,
      aiModel: narrative.model,
      startedAt,
      completedAt: new Date(),
    });

    return presentAnalysis(stored, {
      adId: input.adId,
      creativeId: subject.creativeId,
      score,
      reused: false,
      aiReadingIncludedInPlan: ctx.aiReadingIncludedInPlan,
      // Sem `+ 1`: a reserva já incrementou o contador, e somar de novo
      // mostraria uma análise a mais do que a organização de fato consumiu.
      quota: ctx.quota,
    });
  }
}
