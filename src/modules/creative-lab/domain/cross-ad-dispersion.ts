/**
 * Comparação entre anúncios do **mesmo criativo** (§11.3).
 *
 * A pergunta que ela responde: *o mesmo criativo rende igual em todos os
 * anúncios em que roda?* Dispersão baixa com score baixo indica criativo ruim;
 * dispersão alta indica criativo bom com público errado em um dos anúncios.
 *
 * As quatro regras da tabela de §11.3 estão aqui, e cada uma existe contra um
 * modo de errar concreto.
 */

export type ComparableAd = {
  adId: string;
  aiScore: number;
  aiConfidence: number;
  /** A cobertura **absoluta**: é ela que decide compatibilidade, não a razão. */
  componentCoverage: number;
  adSetId: string | null;
};

export type DispersionMeasure = 'IQR' | 'MAD';

export type DispersionResult = {
  measure: DispersionMeasure;
  value: number;
  sampleSize: number;
  /** Mediana dos scores comparados — o centro sobre o qual a dispersão fala. */
  median: number;
};

export type CrossAdVerdict = {
  value: 'AUDIENCE_MISMATCH' | 'CREATIVE_UNDERPERFORMS' | 'CONSISTENT';
  confidence: number;
  /**
   * P7 — público é **uma hipótese** entre lance, orçamento, posicionamento e
   * tempo em veiculação. Apresentar o veredito sem as alternativas o transforma
   * de leitura em diagnóstico, e o usuário age sobre a diferença.
   */
  alternativeExplanations: string[];
};

export type CrossAdComparison = {
  /** Os anúncios que entraram na comparação, depois dos filtros. */
  compared: ComparableAd[];
  /** Os que ficaram de fora, com o motivo. Reportado, nunca omitido (P7). */
  excluded: Array<{ adId: string; reason: string }>;
  dispersion: DispersionResult | null;
  /** `null` abaixo do mínimo: a comparação é exibida **sem conclusão**. */
  verdict: CrossAdVerdict | null;
};

/**
 * Mínimo de três anúncios com evidência suficiente.
 *
 * *"Diferença entre dois pontos não é dispersão"* — com dois, qualquer distância
 * vira 100% do sinal, e o veredito descreve o acaso.
 */
export const MIN_ADS_FOR_VERDICT = 3;

/**
 * Quanto a cobertura pode variar entre os anúncios comparados.
 *
 * *"Comparar 5 componentes com 2 produz dispersão artificial"*: os dois scores
 * são válidos, mas medem coisas diferentes, e a diferença entre eles fala mais
 * sobre o que a plataforma expôs do que sobre o criativo.
 */
export const MAX_COVERAGE_SPREAD = 0.2;

/** Confiança mínima para um anúncio entrar na comparação (§12.4). */
export const MIN_CONFIDENCE_FOR_COMPARISON = 0.4;

/**
 * Acima disto, a dispersão é alta: o mesmo criativo rende de formas muito
 * diferentes, e o público do ad set passa a ser a hipótese principal.
 */
export const HIGH_DISPERSION_THRESHOLD = 20;

export function compareAdsOfCreative(ads: ComparableAd[]): CrossAdComparison {
  const excluded: Array<{ adId: string; reason: string }> = [];

  const confident = ads.filter((ad) => {
    if (ad.aiConfidence < MIN_CONFIDENCE_FOR_COMPARISON) {
      excluded.push({
        adId: ad.adId,
        reason: `confiança ${ad.aiConfidence} abaixo do piso de ${MIN_CONFIDENCE_FOR_COMPARISON}`,
      });
      return false;
    }
    return true;
  });

  const compared = filterByCompatibleCoverage(confident, excluded);

  if (compared.length < MIN_ADS_FOR_VERDICT) {
    // **Sem veredito abaixo do mínimo.** A comparação é exibida sem conclusão —
    // que é diferente de não exibir: o usuário vê os anúncios e a ausência de
    // diagnóstico é declarada, em vez de o produto inventar um.
    return {
      compared,
      excluded,
      dispersion:
        compared.length > 0
          ? dispersionOf(compared.map((a) => a.aiScore))
          : null,
      verdict: null,
    };
  }

  const scores = compared.map((ad) => ad.aiScore);
  const dispersion = dispersionOf(scores);

  return {
    compared,
    excluded,
    dispersion,
    verdict: verdictFrom(dispersion, compared),
  };
}

/**
 * Dispersão por **IQR**, com queda para **MAD** em amostra pequena.
 *
 * Nunca `max − min`: *um outlier não pode definir o diagnóstico.* Com um anúncio
 * anômalo entre cinco, a amplitude descreve o anômalo e ignora os outros quatro
 * — e a recomendação sairia sobre o caso que menos importa.
 *
 * O IQR precisa de quatro pontos para ter quartis distintos; abaixo disso o MAD
 * é a medida robusta que ainda funciona.
 */
export function dispersionOf(values: number[]): DispersionResult {
  const sorted = [...values].sort((a, b) => a - b);
  const median = medianOf(sorted);

  if (sorted.length >= 4) {
    const q1 = quantile(sorted, 0.25);
    const q3 = quantile(sorted, 0.75);
    return {
      measure: 'IQR',
      value: round2(q3 - q1),
      sampleSize: sorted.length,
      median: round2(median),
    };
  }

  const deviations = sorted.map((value) => Math.abs(value - median));
  return {
    measure: 'MAD',
    value: round2(medianOf([...deviations].sort((a, b) => a - b))),
    sampleSize: sorted.length,
    median: round2(median),
  };
}

/**
 * Só compara scores com cobertura compatível.
 *
 * A âncora é a **mediana** da cobertura, não a maior: ancorar no máximo faria um
 * único anúncio bem medido expulsar todos os outros da comparação.
 */
function filterByCompatibleCoverage(
  ads: ComparableAd[],
  excluded: Array<{ adId: string; reason: string }>,
): ComparableAd[] {
  if (ads.length === 0) return [];

  const anchor = medianOf(
    [...ads.map((ad) => ad.componentCoverage)].sort((a, b) => a - b),
  );

  return ads.filter((ad) => {
    if (Math.abs(ad.componentCoverage - anchor) > MAX_COVERAGE_SPREAD) {
      excluded.push({
        adId: ad.adId,
        reason: `cobertura ${ad.componentCoverage} incompatível com a mediana ${round2(anchor)}`,
      });
      return false;
    }
    return true;
  });
}

/**
 * A leitura de §11.3, com as alternativas sempre declaradas.
 *
 * Nenhum veredito aqui é causal. "Público errado" é a hipótese mais provável
 * quando o mesmo criativo rende de formas diferentes — mas orçamento, lance,
 * posicionamento e tempo em veiculação explicam o mesmo padrão, e o usuário age
 * sobre a diferença entre "é o público" e "pode ser o público".
 */
function verdictFrom(
  dispersion: DispersionResult,
  compared: ComparableAd[],
): CrossAdVerdict {
  const distintosAdSets = new Set(
    compared.map((ad) => ad.adSetId).filter(Boolean),
  ).size;

  const alternativas = [
    'orçamentos díspares entre os conjuntos',
    'tempo em veiculação desigual',
    'posicionamentos diferentes na mesma plataforma',
  ];

  // A confiança do veredito herda a dos anúncios comparados: um diagnóstico não
  // pode ser mais confiante que a evidência que o sustenta.
  const confidence = round2(
    compared.reduce((sum, ad) => sum + ad.aiConfidence, 0) / compared.length,
  );

  if (dispersion.value >= HIGH_DISPERSION_THRESHOLD) {
    return {
      value: 'AUDIENCE_MISMATCH',
      // Com um ad set só, "público diferente" perde a explicação mais natural —
      // e a confiança cai, em vez de o veredito mudar de nome.
      confidence: distintosAdSets > 1 ? confidence : round2(confidence * 0.6),
      alternativeExplanations: alternativas,
    };
  }

  if (dispersion.median < 45) {
    return {
      value: 'CREATIVE_UNDERPERFORMS',
      confidence,
      alternativeExplanations: [
        'janela curta demais para o aprendizado da plataforma estabilizar',
        ...alternativas,
      ],
    };
  }

  return {
    value: 'CONSISTENT',
    confidence,
    alternativeExplanations: [],
  };
}

function medianOf(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/** Interpolação linear — o método que não inventa um ponto que não existe. */
function quantile(sorted: number[], q: number): number {
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);

  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
