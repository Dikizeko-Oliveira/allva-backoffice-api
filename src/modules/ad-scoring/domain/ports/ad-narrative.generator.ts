import type { ScoreComponentName } from '../contracts/score-model';

/**
 * O contrato de narrativa por **assunto** (§12.6, entrega 12 de A2-S4).
 *
 * O módulo `ai` de A2-S1 ficou com o roteamento multi-provider intacto e sem
 * consumidor. Este é o consumidor — e ele não pede "gere um texto": pede uma
 * narrativa **sobre um score**, com os componentes que existem e os que não
 * existem, para que o modelo não invente evidência sobre o que ninguém mediu.
 *
 * Um contrato genérico (`prompt: string`) devolveria ao chamador a tarefa de
 * montar o prompt, e a primeira mudança de modelo espalharia por cinco módulos.
 */
export type AdNarrativeRequest = {
  adName: string;
  platform: string;
  aiScore: number;
  aiConfidence: number;
  coverageRatio: number;
  /** Componentes que entraram no número, com valor nativo e motivo. */
  components: Array<{
    name: ScoreComponentName;
    value: number | null;
    available: boolean;
    reasons: string[];
  }>;
  /**
   * Por que cada componente ausente não pôde ser medido. Vai no prompt de
   * propósito: sem isso o modelo preenche a lacuna com invenção, e P7 exige que
   * a ausência seja declarada, não disfarçada.
   */
  unavailableReasons: Partial<Record<ScoreComponentName, string>>;
  windowDays: number;
};

export type AdNarrativeResult = {
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
   * `true` quando o provider primário falhou e o roteamento caiu para o
   * secundário. É o que impede o benchmark de custo-por-modelo de errar
   * justamente nas chamadas que mais interessam.
   */
  fallbackUsed: boolean;
};

/**
 * Port de geração. **Pode lançar** — e quem chama trata (P4).
 *
 * O contrato deliberadamente não promete `null` em caso de falha: quem decide
 * que falha de IA vira campo nulo é `ScoreEnrichmentService`, num lugar só, e
 * não cada implementação de provider por conta própria.
 */
export abstract class AdNarrativeGenerator {
  abstract generate(request: AdNarrativeRequest): Promise<AdNarrativeResult>;
}
