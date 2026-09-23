import type { CrossAdComparison } from '../cross-ad-dispersion';
import type { CandidateResolution } from '../creative-candidates';

/**
 * O narrador da análise criativa (§11.5, P4).
 *
 * **É costura, não motor.** O diagnóstico — dispersão, veredito, candidatos —
 * sai inteiro de funções puras antes de qualquer chamada de LLM. O que este port
 * produz é a explicação em texto do que já foi decidido, e com todos os
 * provedores fora do ar a análise continua a mesma.
 *
 * Declarado em `creative-lab` e implementado sobre o roteamento multi-provider
 * de `ai`: o módulo que sabe **o que** dizer declara o contrato; o que sabe
 * **como** falar o implementa.
 */

export type AnalysisNarrativeRequest = {
  organizationId: string;
  adId: string;
  adName: string;
  platform: string;
  aiScore: number;
  aiConfidence: number;
  comparison: CrossAdComparison;
  candidates: CandidateResolution;
};

export type AnalysisNarrative = {
  /** O texto. Curto por contrato: é legenda de diagnóstico, não relatório. */
  narrative: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * **Custo não sai daqui.**
   *
   * O narrador é transporte: sabe modelo e tokens, não sabe de que organização é
   * a chamada — e o preço em moeda-base depende da moeda-base **dela**. Quem
   * calcula é o serviço de enriquecimento, que já lê o orçamento por
   * organização e é onde a decisão de gastar mora.
   */
  /**
   * Caiu para o provider secundário?
   *
   * É o que impede o benchmark de custo-por-modelo de errar justamente nas
   * chamadas que trocaram de provider no meio.
   */
  fallbackUsed: boolean;
};

export abstract class AnalysisNarrator {
  abstract narrate(
    request: AnalysisNarrativeRequest,
  ): Promise<AnalysisNarrative>;
}
