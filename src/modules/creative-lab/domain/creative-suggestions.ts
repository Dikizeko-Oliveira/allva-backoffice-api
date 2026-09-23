import type { CrossAdVerdict } from './cross-ad-dispersion';

/**
 * **A ponte entre a análise e a geração de copy** (§11.4, passo 5).
 *
 * `creative_suggestion` **não é a copy**. Ela representa *o que deveria mudar e
 * por quê* — e é justamente essa separação que mantém análise e geração
 * desacopladas: o diagnóstico continua determinístico e auditável, e o texto,
 * que é a única parte autoral, entra depois.
 *
 * ## A formulação de P4 que vale nesta superfície
 *
 * Em todo o resto da plataforma P4 diz: o número é determinístico, a IA explica.
 * Aqui a IA **produz o artefato**, e fingir que a regra antiga se aplica seria
 * uma exceção não escrita. A regra desta feature é outra, e este arquivo é onde
 * ela é cumprida:
 *
 * > **O determinístico decide o que mudar e por quê; o LLM escreve as palavras.**
 *
 * Consequência verificável: com todos os provedores de IA fora do ar, a sugestão
 * continua sendo produzida, persistida e exibida. O que falta é a variação de
 * texto — nunca o diagnóstico.
 *
 * ## Nenhuma sugestão sem número que a sustente
 *
 * Cada regra abaixo cita, no `reason`, o valor observado que a disparou (P7).
 * A alternativa — "o hook parece fraco" — é uma afirmação que o produto não pode
 * defender quando alguém perguntar de onde ela saiu.
 *
 * As funções aqui são **puras e sem DI**, como as duas irmãs deste diretório
 * (`cross-ad-dispersion` e `creative-candidates`), e pelo mesmo motivo: o tipo de
 * entrada é declarado aqui em vez de importado de `ad-scoring`. Um `import` de
 * port de outro módulo dentro de `domain/` acopla a comparação ao formato de
 * quem calcula, e o mapeamento barato mora na camada de aplicação.
 */

/** Onde a mudança incide — casa com as quatro colunas de `creative_analyses`. */
export type SuggestionTarget = 'HOOK' | 'BODY' | 'CTA' | 'FORMAT';

export type SuggestionType =
  /** Abertura não segura a atenção: `attention` baixo. */
  | 'WEAK_HOOK'
  /** O corpo não tem texto suficiente para sustentar promessa nenhuma. */
  | 'THIN_BODY'
  /** O criativo não tem título — campo que a plataforma aceita e está vazio. */
  | 'MISSING_HEADLINE'
  /** Chega gente errada: a mensagem promete a quem não converte. */
  | 'MESSAGE_ATTRACTS_WRONG_AUDIENCE'
  /** Risco de feedback negativo alto: tom ou promessa irritam quem vê. */
  | 'NEGATIVE_FEEDBACK_RISK'
  /** A mensagem se esgotou no público — repetir as mesmas palavras não resolve. */
  | 'MESSAGE_EXHAUSTED'
  /** Não há chamada para ação declarada no criativo. */
  | 'MISSING_CTA'
  /** Há CTA, mas o desempenho aponta para o que acontece depois do clique. */
  | 'WEAK_CTA';

export type SuggestionPriority = 'LOW' | 'MEDIUM' | 'HIGH';

export type CreativeSuggestion = {
  type: SuggestionType;
  target: SuggestionTarget;
  priority: SuggestionPriority;
  /** O que foi observado, **com o número** que o sustenta (P7). */
  reason: string;
  /** O que mudar. Nunca o texto novo — isso é trabalho da geração. */
  recommendation: string;
  /** Herdada do componente que originou a regra: sugestão não inventa certeza. */
  confidence: number;
  /** `null` nas regras que olham o criativo, não o desempenho. */
  sourceComponent: ScoreComponentKey | null;
};

/**
 * O conjunto, separado pelas quatro colunas que o schema já declara.
 *
 * `withheld` é a metade que uma lista vazia não consegue dizer. Sem ele, "a
 * análise concluiu que mexer no texto não é o remédio" e "não olhamos" chegam
 * idênticos à tela — e o usuário reescreve a copy de um criativo que estava
 * certo.
 */
export type SuggestionSet = {
  hook: CreativeSuggestion[];
  body: CreativeSuggestion[];
  cta: CreativeSuggestion[];
  format: CreativeSuggestion[];
  withheld: string | null;
};

export type ScoreComponentKey =
  | 'attention'
  | 'audienceFit'
  | 'learningStability'
  | 'negativeFeedbackRisk'
  | 'fatigue';

/**
 * A leitura de um componente, na forma mínima que estas regras precisam.
 *
 * `normalizedValue` é **0..100 crescente nos cinco** — inclusive nos dois
 * invertidos (`negativeFeedbackRisk` e `fatigue`), que já chegam normalizados
 * pelo cálculo. Perto de zero é sempre pior, e é isso que permite uma régua só
 * para todos.
 */
export type ScoreComponentReading = {
  available: boolean;
  normalizedValue: number | null;
  confidence: number;
};

/** A copy que está no ar agora — a única fonte legítima de "melhorar". */
export type CurrentCopy = {
  headline: string | null;
  body: string | null;
  callToAction: string | null;
};

export type SuggestionInput = {
  components: Partial<Record<ScoreComponentKey, ScoreComponentReading>>;
  /** `null` abaixo de três anúncios comparáveis (§11.3). */
  verdict: CrossAdVerdict | null;
  copy: CurrentCopy;
};

/**
 * Abaixo disto o componente é fraco o bastante para virar sugestão.
 *
 * Alinhado com o piso de ordenação de §12.4 lido na outra escala: um componente
 * em 40/100 é o ponto em que a diferença deixa de ser ruído da janela. Acima
 * dele, sugerir reescrita é pedir que o usuário mexa no que está funcionando.
 */
export const WEAK_COMPONENT = 40;

/** Abaixo disto a prioridade sobe: não é "dá para melhorar", é "está quebrado". */
export const CRITICAL_COMPONENT = 25;

/**
 * Confiança mínima para o componente poder originar sugestão.
 *
 * Mesmo piso de `MIN_CONFIDENCE_FOR_COMPARISON`, e pela mesma razão: um
 * componente medido em três dias de dado não deve mandar ninguém reescrever um
 * anúncio. Sem o piso, o primeiro dia de veiculação produziria a lista inteira.
 */
export const MIN_CONFIDENCE_TO_SUGGEST = 0.4;

/**
 * Abaixo disto o corpo não sustenta promessa nenhuma.
 *
 * É contagem de caractere, não julgamento de qualidade — e por isso é
 * verificável. "O texto é genérico" seria uma opinião que o produto não pode
 * defender sem um modelo por trás, e um modelo por trás faria a sugestão deixar
 * de ser determinística.
 */
export const THIN_BODY_CHARS = 60;

export function suggestCopyChanges(input: SuggestionInput): SuggestionSet {
  const set: SuggestionSet = {
    hook: [],
    body: [],
    cta: [],
    format: [],
    withheld: null,
  };

  /**
   * **O veredito pode recusar a sugestão inteira, e essa recusa é o produto.**
   *
   * `AUDIENCE_MISMATCH` significa que o mesmo criativo rende bem em outros
   * anúncios: a peça funciona, e o que difere é onde ela está rodando (§11.3).
   * Emitir "reescreva o hook" aqui mandaria o usuário consertar o que está
   * certo — e o remédio real (olhar o anúncio de pior score) ficaria escondido
   * atrás de um botão de gerar texto.
   *
   * O que sobrevive à recusa são as regras **factuais** — CTA ausente, título
   * ausente. Elas não afirmam nada sobre desempenho: descrevem um campo vazio,
   * e um campo vazio continua vazio mesmo quando o criativo é bom.
   */
  const performanceWithheld = input.verdict?.value === 'AUDIENCE_MISMATCH';

  if (performanceWithheld) {
    set.withheld =
      'A comparação entre os anúncios deste criativo indica público errado em ' +
      'um deles, não problema de texto: a mesma peça rende bem nos outros. ' +
      'Reescrever a copy consertaria o que não está quebrado.';
  }

  const escalate = input.verdict?.value === 'CREATIVE_UNDERPERFORMS';

  if (!performanceWithheld) {
    pushPerformanceRules(set, input, escalate);
  }

  pushFactualRules(set, input);

  return set;
}

/** As regras que partem do desempenho medido — as que o veredito pode reter. */
function pushPerformanceRules(
  set: SuggestionSet,
  input: SuggestionInput,
  escalate: boolean,
): void {
  const attention = usable(input.components.attention);

  if (attention !== null && attention.value < WEAK_COMPONENT) {
    set.hook.push({
      type: 'WEAK_HOOK',
      target: 'HOOK',
      priority: rank(attention.value, escalate),
      reason:
        `A retenção nos primeiros segundos está em ${fmt(attention.value)}/100 ` +
        `(confiança ${attention.confidence.toFixed(2)}): a abertura não está ` +
        'segurando quem chega.',
      recommendation:
        'Leve o benefício principal para a primeira linha e torne a abertura ' +
        'específica — resultado concreto no lugar da promessa geral.',
      confidence: attention.confidence,
      sourceComponent: 'attention',
    });
  }

  const fit = usable(input.components.audienceFit);

  if (fit !== null && fit.value < WEAK_COMPONENT) {
    set.body.push({
      type: 'MESSAGE_ATTRACTS_WRONG_AUDIENCE',
      target: 'BODY',
      priority: rank(fit.value, escalate),
      reason:
        `O encaixe com o público está em ${fmt(fit.value)}/100 ` +
        `(confiança ${fit.confidence.toFixed(2)}): quem chega pelo anúncio não ` +
        'é quem converte.',
      recommendation:
        'Qualifique no próprio texto para quem a oferta é, e nomeie a dor que ' +
        'ela resolve antes de nomear o produto.',
      confidence: fit.confidence,
      sourceComponent: 'audienceFit',
    });
  }

  const risk = usable(input.components.negativeFeedbackRisk);

  if (risk !== null && risk.value < WEAK_COMPONENT) {
    set.body.push({
      type: 'NEGATIVE_FEEDBACK_RISK',
      target: 'BODY',
      priority: rank(risk.value, escalate),
      reason:
        `O risco de feedback negativo está em ${fmt(risk.value)}/100 ` +
        `(confiança ${risk.confidence.toFixed(2)}): parte de quem vê está ` +
        'reagindo mal ao anúncio.',
      recommendation:
        'Reveja tom e promessa: troque afirmação categórica por afirmação ' +
        'verificável e remova urgência artificial.',
      confidence: risk.confidence,
      sourceComponent: 'negativeFeedbackRisk',
    });
  }

  const fatigue = usable(input.components.fatigue);

  if (fatigue !== null && fatigue.value < WEAK_COMPONENT) {
    set.format.push({
      type: 'MESSAGE_EXHAUSTED',
      target: 'FORMAT',
      priority: rank(fatigue.value, escalate),
      reason:
        `A fadiga está em ${fmt(fatigue.value)}/100 ` +
        `(confiança ${fatigue.confidence.toFixed(2)}): o público já viu esta ` +
        'mensagem vezes demais.',
      recommendation:
        'Mude o ângulo, não as palavras: a mesma promessa reescrita continua ' +
        'sendo a mensagem que o público já cansou de ver.',
      confidence: fatigue.confidence,
      sourceComponent: 'fatigue',
    });
  }

  /**
   * `WEAK_CTA` — **público certo chegando e desempenho ruim mesmo assim**.
   *
   * É a mesma leitura que `planReplaceCta` faz em `recommendations`: com
   * `audienceFit` alto, a segmentação está correta, e o que resta é o que
   * acontece depois do clique. A diferença é a evidência disponível de cada
   * lado — lá é ROAS contra a mediana dos pares, aqui é o próprio composto
   * baixo com encaixe alto. As duas apontam para o mesmo lugar sem uma precisar
   * importar a outra.
   */
  if (
    fit !== null &&
    fit.value >= 60 &&
    attention !== null &&
    attention.value >= WEAK_COMPONENT &&
    input.verdict?.value === 'CREATIVE_UNDERPERFORMS'
  ) {
    set.cta.push({
      type: 'WEAK_CTA',
      target: 'CTA',
      priority: 'MEDIUM',
      reason:
        `O encaixe com o público está bom (${fmt(fit.value)}/100) e a abertura ` +
        `também (${fmt(attention.value)}/100), mas a comparação entre os ` +
        'anúncios deste criativo aponta desempenho baixo em toda parte.',
      recommendation:
        'O que difere está depois do clique: torne a chamada para ação ' +
        'específica sobre o próximo passo, em vez de genérica.',
      confidence: Math.min(fit.confidence, attention.confidence),
      sourceComponent: 'audienceFit',
    });
  }
}

/**
 * As regras que olham o **criativo**, não o desempenho.
 *
 * Sobrevivem à recusa do veredito porque não afirmam nada que o veredito possa
 * contradizer: um campo vazio é um fato sobre a peça, e continua verdadeiro
 * quando ela está indo bem.
 */
function pushFactualRules(set: SuggestionSet, input: SuggestionInput): void {
  const body = input.copy.body?.trim() ?? '';

  if (body.length > 0 && body.length < THIN_BODY_CHARS) {
    set.body.push({
      type: 'THIN_BODY',
      target: 'BODY',
      priority: 'LOW',
      reason:
        `O texto principal tem ${body.length} caracteres — abaixo dos ` +
        `${THIN_BODY_CHARS} que sustentam uma promessa com prova.`,
      recommendation:
        'Some ao texto o resultado concreto e uma evidência dele. Curto não é ' +
        'o problema; curto sem prova é.',
      // Fato sobre o criativo: não há incerteza de medição a herdar.
      confidence: 1,
      sourceComponent: null,
    });
  }

  if (!input.copy.headline?.trim()) {
    set.hook.push({
      type: 'MISSING_HEADLINE',
      target: 'HOOK',
      priority: 'MEDIUM',
      reason: 'O criativo não tem título preenchido.',
      recommendation:
        'Escreva um título que diga o resultado, não a categoria do produto.',
      confidence: 1,
      sourceComponent: null,
    });
  }

  if (!input.copy.callToAction?.trim()) {
    set.cta.push({
      type: 'MISSING_CTA',
      target: 'CTA',
      priority: 'MEDIUM',
      reason: 'O criativo não declara chamada para ação.',
      recommendation:
        'Declare o próximo passo esperado — o que a pessoa faz agora, em uma ' +
        'ação só.',
      confidence: 1,
      sourceComponent: null,
    });
  }
}

/**
 * O componente **utilizável**: presente, medido e com confiança acima do piso.
 *
 * Os três motivos de recusa produzem o mesmo resultado — nenhuma sugestão — e
 * isso é deliberado: componente indisponível na plataforma, sem valor medido ou
 * medido com confiança baixa são todos "não sabemos o suficiente para mandar
 * alguém reescrever um anúncio".
 */
function usable(
  reading: ScoreComponentReading | undefined,
): { value: number; confidence: number } | null {
  if (!reading?.available) return null;
  if (reading.normalizedValue === null) return null;
  if (reading.confidence < MIN_CONFIDENCE_TO_SUGGEST) return null;

  return { value: reading.normalizedValue, confidence: reading.confidence };
}

function rank(value: number, escalate: boolean): SuggestionPriority {
  if (value < CRITICAL_COMPONENT) return 'HIGH';
  return escalate ? 'HIGH' : 'MEDIUM';
}

function fmt(value: number): string {
  return value.toFixed(0);
}

/** Quantas sugestões o conjunto carrega — a contagem que a tela e o log usam. */
export function countSuggestions(set: SuggestionSet): number {
  return set.hook.length + set.body.length + set.cta.length + set.format.length;
}

/**
 * As sugestões em uma lista só, ordenadas por prioridade.
 *
 * É o que a geração consome: o prompt precisa da ordem, e reproduzir a
 * ordenação em cada consumidor é como dois lugares passam a discordar sobre qual
 * é o problema principal do anúncio.
 */
export function rankedSuggestions(set: SuggestionSet): CreativeSuggestion[] {
  const weight: Record<SuggestionPriority, number> = {
    HIGH: 0,
    MEDIUM: 1,
    LOW: 2,
  };

  return [...set.hook, ...set.body, ...set.cta, ...set.format].sort(
    (a, b) =>
      weight[a.priority] - weight[b.priority] || b.confidence - a.confidence,
  );
}
