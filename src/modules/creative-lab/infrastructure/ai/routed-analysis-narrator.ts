import { Injectable } from '@nestjs/common';
import { TextGenerationProviderInterface } from 'src/modules/ai/contracts';
import {
  AnalysisNarrator,
  type AnalysisNarrative,
  type AnalysisNarrativeRequest,
} from 'src/modules/creative-lab/domain/ports/analysis-narrator.port';

/**
 * A narrativa da análise criativa, sobre o mesmo roteamento multi-provider que
 * o score usa desde A2-S4 (§12.6).
 *
 * **O prompt declara o que a comparação NÃO concluiu.** É a mesma razão do
 * narrador de score: o modelo preenche lacuna com invenção, e ele é bom nisso.
 * Uma comparação com menos de três anúncios comparáveis **não tem veredito**
 * (§11.3), e sem isso no prompt o texto explicaria confiantemente um diagnóstico
 * que o produto se recusou a emitir.
 */
@Injectable()
export class RoutedAnalysisNarrator extends AnalysisNarrator {
  constructor(private readonly text: TextGenerationProviderInterface) {
    super();
  }

  async narrate(request: AnalysisNarrativeRequest): Promise<AnalysisNarrative> {
    const generated = await this.text.generateText({
      // `creative_diagnosis` já existia em `AITaskType` desde A2-S4, declarado
      // para §11.2 e sem emissor até aqui. Criar um tipo novo deixaria o antigo
      // órfão — que é o achado de vocabulário morto que o próprio arquivo de
      // tipos registra ter acontecido antes.
      task: 'creative_diagnosis',
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: buildUserPrompt(request),
      maxCharacters: MAX_CHARACTERS,
    });

    return {
      narrative: generated.text,
      provider: generated.provider,
      model: generated.model,
      inputTokens: generated.inputTokens ?? 0,
      outputTokens: generated.outputTokens ?? 0,
      fallbackUsed: generated.fallbackUsed,
    };
  }
}

/** Mesmo orçamento do narrador de score, e pelo mesmo motivo: ver lá. */

const MAX_CHARACTERS = 400;

const SYSTEM_PROMPT = [
  'Você explica, em português do Brasil, como um criativo se comporta entre os',
  'anúncios em que ele roda.',
  `Escreva no máximo três frases e ${MAX_CHARACTERS} caracteres, sem saudação e sem listas.`,
  'Termine sempre a última frase — texto cortado no meio é pior que texto curto.',
  'NUNCA invente número: use apenas os valores fornecidos.',
  'Quando não houver veredito, diga que não houve e por quê — nunca conclua no lugar dele.',
  'Não recomende ações: outra parte do produto faz isso.',
].join(' ');

function buildUserPrompt(request: AnalysisNarrativeRequest): string {
  const { comparison, candidates } = request;

  const linhas = [
    `Anúncio: ${request.adName} (${request.platform})`,
    `AI Score: ${request.aiScore.toFixed(1)} com confiança ${request.aiConfidence.toFixed(2)}`,
    `Anúncios comparáveis do mesmo criativo: ${comparison.compared.length}`,
  ];

  if (comparison.dispersion) {
    linhas.push(
      `Dispersão (${comparison.dispersion.measure}): ${comparison.dispersion.value.toFixed(1)} ` +
        `sobre mediana ${comparison.dispersion.median.toFixed(1)}`,
    );
  }

  /**
   * **A ausência de veredito é dito, não omitido.** Omiti-la faria o modelo
   * escolher uma explicação — e o produto passaria a afirmar por LLM o que
   * §11.3 recusou afirmar por regra.
   */
  if (comparison.verdict) {
    linhas.push(
      `Veredito: ${comparison.verdict.value} (confiança ${comparison.verdict.confidence.toFixed(2)})`,
      `Explicações alternativas: ${comparison.verdict.alternativeExplanations.join('; ')}`,
    );
  } else {
    linhas.push(
      'SEM VEREDITO: menos anúncios comparáveis que o mínimo de três. Não conclua nada sobre o criativo.',
    );
  }

  if (comparison.excluded.length > 0) {
    linhas.push(
      `Excluídos da comparação: ${comparison.excluded
        .map((item) => `${item.adId} (${item.reason})`)
        .join('; ')}`,
    );
  }

  linhas.push(
    candidates.kind === 'CANDIDATES'
      ? `Criativos substitutos disponíveis na conta: ${candidates.candidates.length}`
      : `Sem substituto na conta: ${candidates.reason}`,
  );

  return linhas.join('\n');
}
