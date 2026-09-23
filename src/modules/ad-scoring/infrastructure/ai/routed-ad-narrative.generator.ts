import { Injectable } from '@nestjs/common';
import { TextGenerationProviderInterface } from 'src/modules/ai/contracts';
import {
  AdNarrativeGenerator,
  AdNarrativeRequest,
  AdNarrativeResult,
} from 'src/modules/ad-scoring/domain/ports/ad-narrative.generator';
import type { ScoreComponentName } from 'src/modules/ad-scoring/domain/contracts/score-model';

/**
 * A narrativa do score, sobre o roteamento multi-provider que A2-S1 preservou
 * sem consumidor (§12.6).
 *
 * **O prompt declara o que NÃO foi medido.** Sem isso o modelo preenche a lacuna
 * com invenção — ele é bom nisso —, e o produto passaria a afirmar sobre
 * componentes que nenhuma plataforma expõe. P7 exige que a ausência seja
 * declarada, e a única forma de o modelo respeitá-la é ela estar no prompt.
 */
@Injectable()
export class RoutedAdNarrativeGenerator extends AdNarrativeGenerator {
  constructor(private readonly text: TextGenerationProviderInterface) {
    super();
  }

  async generate(request: AdNarrativeRequest): Promise<AdNarrativeResult> {
    const generated = await this.text.generateText({
      task: 'ad_narrative',
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

/**
 * O orçamento vive numa constante só, e entra no prompt **e** no corte.
 *
 * Separados, eles divergem: o prompt pedia "três frases" sem número, o corte
 * valia 400 caracteres, e o resultado era o modelo escrever mais do que cabia
 * — nove em cada dez narrativas terminavam no meio de uma palavra. Dizer o
 * limite ao modelo é o que faz o corte quase nunca precisar agir; o corte
 * continua existindo porque "quase nunca" não é "nunca".
 */
const MAX_CHARACTERS = 400;

const SYSTEM_PROMPT = [
  'Você explica, em português do Brasil, por que um anúncio recebeu determinada pontuação.',
  `Escreva no máximo três frases e ${MAX_CHARACTERS} caracteres, sem saudação e sem listas.`,
  'Termine sempre a última frase — texto cortado no meio é pior que texto curto.',
  'NUNCA invente número: use apenas os valores fornecidos.',
  'NUNCA comente componentes marcados como não medidos — diga que não foram medidos e por quê.',
  'Use os nomes dos componentes exatamente como aparecem, em português.',
  'Escreva em prosa: NUNCA copie o formato "nome: valor" dos dados para o texto.',
  'Não recomende ações: outra parte do produto faz isso.',
].join(' ');

/**
 * Os componentes em português, traduzidos **antes** do prompt.
 *
 * `attention`, `audienceFit` e `learningStability` são identificadores do
 * domínio, e iam crus para o modelo — que os repetia fielmente no meio de prosa
 * em português: *"o audienceFit ficou em 99 e o learningStability em 100"*. Lê
 * como vazamento de debug, e nenhuma instrução de prompt conserta isso de forma
 * confiável: o modelo não pode deixar de citar um identificador que nunca viu.
 * Traduzir na fronteira resolve na origem.
 */
const COMPONENT_LABELS: Readonly<Record<ScoreComponentName, string>> = {
  attention: 'atenção',
  audienceFit: 'aderência ao público',
  learningStability: 'estabilidade de aprendizado',
  negativeFeedbackRisk: 'risco de feedback negativo',
  fatigue: 'fadiga criativa',
};

function labelOf(name: string): string {
  return COMPONENT_LABELS[name as ScoreComponentName] ?? name;
}

function buildUserPrompt(request: AdNarrativeRequest): string {
  const medidos = request.components
    .filter((component) => component.available)
    .map(
      (component) =>
        `${labelOf(component.name)}: ${formatValue(component.value)}` +
        (component.reasons.length > 0
          ? ` (${component.reasons.join('; ')})`
          : ''),
    );

  const naoMedidos = Object.entries(request.unavailableReasons).map(
    ([name, reason]) => `${labelOf(name)}: ${reason}`,
  );

  return [
    `Anúncio: ${request.adName} (${request.platform})`,
    `Score: ${request.aiScore} · confiança ${request.aiConfidence} · cobertura relativa ${request.coverageRatio}`,
    `Janela: ${request.windowDays} dias`,
    `Componentes medidos: ${medidos.length > 0 ? medidos.join(' | ') : 'nenhum'}`,
    `Não medidos: ${naoMedidos.length > 0 ? naoMedidos.join(' | ') : 'nenhum'}`,
  ].join('\n');
}

/**
 * O valor do componente arredondado **antes** do prompt.
 *
 * `fatigue` é 0..1 na escala nativa e chega como float de dupla precisão:
 * `0.281500935744425`. Modelos mais literais copiam o número inteiro para a
 * prosa — *"fadiga criativa=0.281500935744425"* —, e o leitor recebe um dump de
 * ponto flutuante no meio de uma frase em português.
 *
 * Mesma lição de `COMPONENT_LABELS`: o modelo não pode deixar de citar uma
 * precisão que nunca recebeu. Instruir "arredonde" funciona em modelo forte e
 * falha justamente no barato, que é onde o volume está.
 *
 * Duas casas para a escala 0..1, nenhuma para a 0..100: `0,28` diz o que
 * `0,2815` diria, e `84` não vira mais informativo como `84,00`.
 */
function formatValue(value: number | null): string {
  if (value === null) return 'sem valor';
  if (!Number.isFinite(value)) return 'sem valor';

  const rounded = Math.abs(value) < 1 ? value.toFixed(2) : value.toFixed(0);

  return rounded.replace('.', ',');
}
