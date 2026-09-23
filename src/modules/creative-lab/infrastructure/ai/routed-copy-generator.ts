import { Injectable } from '@nestjs/common';
import { StructuredGenerationProviderInterface } from 'src/modules/ai/contracts/structured-generation-provider.contract';
import {
  CopyGenerator,
  type CopyFieldBudget,
  type CopyGenerationRequest,
  type GeneratedCopy,
} from 'src/modules/creative-lab/domain/ports/copy-generator.port';
import { generatedCopySchema } from 'src/modules/creative-lab/domain/schemas/copy-generation.schema';

/**
 * As variações de copy, sobre o roteamento estruturado de `ai`.
 *
 * **Uma chamada para as três variações, não três chamadas.** Além do custo, é o
 * que faz os ângulos serem de fato diferentes: pedindo separado, o modelo não
 * sabe o que já escreveu, e três pedidos de "uma copy melhor" convergem para o
 * mesmo texto com sinônimos trocados — que é exatamente o que a feature não é.
 *
 * **O prompt declara o que a análise NÃO concluiu**, pela mesma razão dos dois
 * narradores: o modelo preenche lacuna com invenção, e ele é bom nisso. Sem o
 * veredito ausente no prompt, a explicação de cada variante afirmaria com
 * confiança um diagnóstico que §11.3 se recusou a emitir.
 */
@Injectable()
export class RoutedCopyGenerator extends CopyGenerator {
  constructor(
    private readonly structured: StructuredGenerationProviderInterface,
  ) {
    super();
  }

  async generate(request: CopyGenerationRequest): Promise<GeneratedCopy> {
    const generated = await this.structured.generateJson({
      /**
       * `creative_suggestion` já existia em `AITaskType` desde A2-S4, roteada
       * para o modelo mais caro do catálogo com a nota *"aqui o texto vira
       * mídia"* e sem emissor. Criar um tipo novo deixaria o antigo órfão — que
       * é o achado de vocabulário morto que o próprio arquivo de tipos registra
       * ter acontecido antes.
       */
      task: 'creative_suggestion',
      systemPrompt: `${SYSTEM_PROMPT}\n\n${OUTPUT_CONTRACT}`,
      userPrompt: buildUserPrompt(request),
      schema: generatedCopySchema,
      maxTokens: MAX_TOKENS,
    });

    return {
      variants: generated.value.variants,
      provider: generated.provider,
      model: generated.model,
      inputTokens: generated.inputTokens ?? 0,
      outputTokens: generated.outputTokens ?? 0,
      fallbackUsed: generated.fallbackUsed,
    };
  }
}

/**
 * Três variações com cinco campos e explicação cabem com folga aqui.
 *
 * Generoso de propósito, e mais generoso desde o primeiro teste contra
 * provedores reais: modelos de raciocínio gastam parte do orçamento **antes** de
 * escrever, e um teto apertado faz a resposta acabar no meio. JSON truncado é
 * JSON inválido, e aqui não existe o corte em fronteira de frase que salva a
 * prosa.
 *
 * `max_tokens` é limite, não consumo — o provider cobra o que gerou, não o que
 * foi autorizado a gerar —, então a folga é grátis.
 */
const MAX_TOKENS = 8_000;

const SYSTEM_PROMPT = [
  'Você escreve copy de anúncio em português do Brasil para um sistema de',
  'inteligência criativa. Recebe um diagnóstico já pronto e escreve o texto que',
  'o corrige.',
  '',
  'Regras que não se negociam:',
  '- NUNCA invente número, prazo, preço, percentual, prêmio ou nome de cliente.',
  '  Use apenas o que o contexto trouxer. Sem dado, escreva sem dado.',
  '- NUNCA prometa resultado garantido nem faça comparação com concorrente',
  '  nomeado: é a marca do anunciante que assina o texto.',
  '- Cada variação testa um ÂNGULO diferente, não sinônimos do mesmo texto.',
  '- Respeite o limite de caracteres declarado em cada campo. Campo com lista de',
  '  valores aceitos recebe UM da lista, exatamente como escrito, nunca uma frase.',
  '- Campo que o contexto não permitir preencher vem como null, nunca inventado.',
  '- Em "reasoning", cada ponto diz o que a variação faz de diferente e cita o',
  '  tipo da sugestão que ele atende em addressesSuggestion. Ponto que não',
  '  corresponde a nenhuma sugestão recebida usa addressesSuggestion: null —',
  '  não force a correspondência.',
  '',
].join('\n');

/**
 * **O contrato da resposta, dentro do prompt.**
 *
 * Não estava aqui, e a ausência derrubou as três primeiras chamadas contra
 * provedores reais: as regras de escrita estavam declaradas, o formato não, e os
 * três modelos devolveram JSON válido com uma forma cada um — nenhuma com
 * `variants` no topo. O schema Zod pegou (é para isso que ele existe), mas pegar
 * na fronteira e nunca acertar é uma rota que só sabe falhar.
 *
 * O esqueleto é literal de propósito. "Devolva um objeto com uma lista de
 * variações" é uma descrição; isto é o alvo, e a diferença entre as duas é a
 * taxa de acerto na primeira tentativa — que aqui custa uma chamada do modelo
 * mais caro do catálogo.
 */
const OUTPUT_CONTRACT = [
  'Responda com este objeto JSON, exatamente com estas chaves:',
  '{',
  '  "variants": [',
  '    {',
  '      "angle": "BENEFIT" | "PAIN" | "OUTCOME" | "PROOF" | "URGENCY",',
  '      "hook": string | null,',
  '      "primaryText": string | null,',
  '      "headline": string | null,',
  '      "description": string | null,',
  '      "callToAction": string | null,',
  '      "reasoning": [',
  '        { "claim": string, "addressesSuggestion": string | null }',
  '      ]',
  '    }',
  '  ]',
  '}',
  '',
  'Todas as chaves acima são obrigatórias em cada variação. Campo sem conteúdo',
  'vem como null — nunca omitido, nunca string vazia.',
  'Nada fora do objeto: sem texto antes, sem texto depois, sem cerca de markdown.',
].join('\n');

function buildUserPrompt(request: CopyGenerationRequest): string {
  const { context } = request;
  const lines: string[] = [];

  lines.push(`Anúncio: ${context.ad.name} (${context.ad.platform})`);

  if (context.ad.campaignObjective) {
    lines.push(
      `Objetivo da campanha na plataforma: ${context.ad.campaignObjective}`,
    );
  }

  if (context.ad.optimizationGoal) {
    lines.push(`Otimização do conjunto: ${context.ad.optimizationGoal}`);
  }

  lines.push('', ...currentCopyLines(request));
  lines.push('', ...diagnosisLines(request));
  lines.push('', ...suggestionLines(request));
  lines.push('', ...briefLines(request));
  lines.push('', ...fieldLines(request.fieldBudgets));
  lines.push(
    '',
    `Escreva exatamente ${request.variantCount} variações, cada uma com um ângulo diferente.`,
    'Ângulos disponíveis: BENEFIT, PAIN, OUTCOME, PROOF, URGENCY.',
    'PROOF só se o contexto trouxer prova real; sem ela, escolha outro ângulo.',
  );

  return lines.join('\n');
}

/**
 * A copy atual entra nas três origens — inclusive em `FROM_BRIEF`, que a ignora.
 *
 * Sem ela no prompt, "começar do zero" viraria "escrever sobre um produto
 * desconhecido": o texto no ar é a única descrição da oferta que a plataforma
 * tem. A instrução é que ela informa o assunto, não a forma.
 */
function currentCopyLines(request: CopyGenerationRequest): string[] {
  const { currentCopy } = request.context;
  const lines = ['COPY ATUAL NO AR:'];

  lines.push(`- Título: ${currentCopy.headline ?? '(vazio)'}`);
  lines.push(`- Texto principal: ${currentCopy.body ?? '(vazio)'}`);
  lines.push(`- Chamada para ação: ${currentCopy.callToAction ?? '(vazia)'}`);

  if (currentCopy.landingPageUrl) {
    lines.push(`- Destino: ${currentCopy.landingPageUrl}`);
  }

  if (request.source === 'FROM_BRIEF') {
    lines.push(
      'ORIGEM DO PEDIDO: recomeçar. Use a copy acima apenas para saber qual é a',
      'oferta; não a preserve nem a parafraseie.',
    );
  }

  if (request.source === 'IMPROVE') {
    lines.push(
      'ORIGEM DO PEDIDO: melhorar. Preserve a proposta e a oferta da copy acima;',
      'mude a execução.',
    );
  }

  return lines;
}

function diagnosisLines(request: CopyGenerationRequest): string[] {
  const { score, analysis } = request.context;
  const lines = ['O QUE A ALLVA MEDIU:'];

  if (score) {
    lines.push(
      `- AI Score ${score.aiScore.toFixed(0)}/100 (confiança ${score.aiConfidence.toFixed(2)})`,
    );

    for (const [name, reading] of Object.entries(score.components)) {
      if (!reading.available || reading.normalizedValue === null) continue;
      lines.push(`- ${name}: ${reading.normalizedValue.toFixed(0)}/100`);
    }
  } else {
    lines.push(
      '- Sem score: o anúncio ainda não completou um ciclo de medição.',
    );
  }

  /**
   * **A ausência de veredito é dita, não omitida.**
   *
   * Uma comparação com menos de três anúncios do mesmo criativo não conclui
   * nada (§11.3). Sem esta linha, o `reasoning` de cada variante explicaria com
   * confiança um diagnóstico que o produto se recusou a emitir — e a explicação
   * é justamente o que dá autoridade ao texto na tela.
   */
  if (analysis?.verdict) {
    lines.push(
      `- Comparação entre anúncios do mesmo criativo: ${analysis.verdict}`,
    );
  } else {
    lines.push(
      '- SEM VEREDITO na comparação entre anúncios do mesmo criativo: não há',
      '  anúncios comparáveis suficientes. Não conclua nada sobre isso.',
    );
  }

  return lines;
}

function suggestionLines(request: CopyGenerationRequest): string[] {
  const { suggestions } = request.context;

  if (suggestions.length === 0) {
    return [
      'SUGESTÕES DA ANÁLISE: nenhuma. Escreva a partir do briefing abaixo e não',
      'atribua à análise nada que ela não disse.',
    ];
  }

  return [
    'O QUE A ANÁLISE RECOMENDA MUDAR (a base das variações):',
    ...suggestions.map(
      (suggestion) =>
        `- [${suggestion.type}] (${suggestion.priority}) ${suggestion.reason} ` +
        `→ ${suggestion.recommendation}`,
    ),
  ];
}

function briefLines(request: CopyGenerationRequest): string[] {
  const { inputs } = request.context;
  const lines = [
    'ESCOLHAS DE QUEM PEDIU:',
    `- Objetivo: ${OBJECTIVE_LABELS[inputs.objective]}`,
    `- Tom: ${TONE_LABELS[inputs.tone]}`,
    `- Foco: ${FOCUS_LABELS[inputs.focus]}`,
  ];

  if (inputs.extraInstructions) {
    lines.push(`- Instruções adicionais: ${inputs.extraInstructions}`);
  }

  return lines;
}

/**
 * Os limites da plataforma, campo a campo, **dentro do prompt**.
 *
 * Reescrever depois custa uma segunda chamada paga; declarar antes custa
 * algumas linhas de entrada. A validação posterior continua existindo porque o
 * modelo erra — mas ela é a rede, não o plano.
 */
function fieldLines(budgets: CopyFieldBudget[]): string[] {
  const lines = ['CAMPOS E LIMITES DESTA PLATAFORMA:'];

  for (const { field, profile } of budgets) {
    const limits: string[] = [];

    if (profile.maxLength !== null) {
      limits.push(
        `máximo ${profile.maxLength} caracteres (a plataforma recusa acima)`,
      );
    }

    if (profile.minLength !== null) {
      limits.push(`mínimo ${profile.minLength}`);
    }

    if (profile.recommendedLength !== null && profile.maxLength === null) {
      limits.push(
        `até ${profile.recommendedLength} caracteres antes de a plataforma cortar`,
      );
    }

    if (profile.allowedValues) {
      limits.push(
        `APENAS um destes valores: ${profile.allowedValues.join(', ')}`,
      );
    }

    lines.push(
      `- ${field}: ${limits.length > 0 ? limits.join('; ') : 'sem limite declarado'}`,
    );
  }

  lines.push(
    'Campo que não estiver nesta lista não existe nesta plataforma: devolva null.',
  );

  return lines;
}

const OBJECTIVE_LABELS = {
  CONVERSION: 'conversão',
  LEADS: 'geração de leads',
  TRAFFIC: 'tráfego',
  AWARENESS: 'reconhecimento',
} as const;

const TONE_LABELS = {
  PROFESSIONAL: 'profissional',
  DIRECT: 'direto',
  PERSUASIVE: 'persuasivo',
  CASUAL: 'casual',
  EDUCATIONAL: 'educacional',
} as const;

const FOCUS_LABELS = {
  BENEFIT: 'benefício',
  PAIN: 'dor',
  OFFER: 'oferta',
  SOCIAL_PROOF: 'prova social',
  URGENCY: 'urgência',
  DIFFERENTIATION: 'diferenciação',
} as const;
