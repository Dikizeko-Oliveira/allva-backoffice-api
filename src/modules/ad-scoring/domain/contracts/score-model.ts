import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import type { MetricField } from 'src/modules/ads/domain/platform/platform-profile';
import { platformProfile } from 'src/modules/ads/domain/platform/platform-profiles';

/**
 * O **modelo público** do AI Score (§12.1, §12.2).
 *
 * Quais componentes existem, com que peso, e de que sinais cada um depende. Isso
 * é **contrato**, não cálculo: `ads` precisa dele para declarar
 * `meta.coverageByPlatform`, `waste` precisará para saber que componente
 * consumir, e nenhum dos dois pode importar a aritmética que compõe o número
 * (D2, §5.3 r.2).
 *
 * A fronteira é essa e é verificável: **o que o score é** mora aqui, em
 * `ports/`; **como ele é calculado** mora em `composition.ts` e `coverage.ts`, e
 * o teste de arquitetura recusa quem atravessar.
 */

export type ScoreComponentName =
  | 'attention'
  | 'audienceFit'
  | 'learningStability'
  | 'negativeFeedbackRisk'
  | 'fatigue';

/** Pesos de §12.3. Somam 1,0 — verificado por teste, não por leitura. */
export const COMPONENT_WEIGHTS: Readonly<Record<ScoreComponentName, number>> = {
  attention: 0.25,
  audienceFit: 0.3,
  learningStability: 0.15,
  negativeFeedbackRisk: 0.15,
  fatigue: 0.15,
};

/**
 * De que sinais cada componente depende.
 *
 * É o que liga o peso do componente às métricas que `PlatformProfile` declara
 * indisponíveis. Sem esse mapa, `platformCoverageMax` seria um número escrito à
 * mão por plataforma — e desatualizaria no primeiro sinal novo.
 */
export const COMPONENT_SIGNALS: Readonly<
  Record<ScoreComponentName, MetricField[]>
> = {
  // Vídeo: não existe para anúncio estático nem para Search — os dois sinais
  // são exatamente `VIDEO_ONLY_SIGNALS`, abaixo.
  attention: ['thumbstopRate', 'holdRate'],
  // Universal: gasto, conversão e receita existem em toda plataforma.
  audienceFit: ['conversions', 'revenue', 'spend'],
  // Universal: variância dia a dia do que já se tem.
  learningStability: ['impressions', 'clicks', 'spend'],
  negativeFeedbackRisk: ['hides', 'hideAllFor', 'reports', 'unlikes'],
  fatigue: ['frequency'],
};

/**
 * Sinais que só nascem em formato de vídeo — nunca em imagem, carrossel ou
 * texto (§12.4, dívida B7-bis).
 *
 * `PlatformProfile.metrics.available` declara "esta PLATAFORMA mede isto",
 * não "todo anúncio desta plataforma produz isto": a Meta e o TikTok
 * medem `thumbstopRate`/`holdRate` porque *têm* vídeo, mas um carrossel de
 * imagem na mesma conta nunca vai gerar esse sinal — não porque faltou dado,
 * mas porque o formato não reproduz vídeo nenhum. O Google entrou no mesmo
 * caso quando passou a ler o quartil de visualização (A2, análise de
 * hooks): a partir daí `thumbstopRate`/`holdRate` também são "medidos pela
 * plataforma" ali, e só pelo anúncio de vídeo.
 *
 * `platformCoverageMaxFor` — o teto **declarativo**, usado no resumo de
 * `GET /ads` (`meta.coverageByPlatform`, que "não muda por anúncio") —
 * continua contando esses pesos: é a pergunta "o que esta plataforma permite
 * medir no melhor caso". `nonVideoCoverageMaxFor`, abaixo, é a pergunta que o
 * cálculo **por anúncio** precisa fazer quando o formato daquele anúncio
 * específico não é vídeo: sem ela, um carrossel de imagem da Meta paga o peso
 * de `attention` (0,25) no piso de cobertura sem nunca ter chance de gerar o
 * sinal — e fica permanentemente abaixo do piso de 0,80 que autoriza escalar
 * orçamento (`SCORE_FLOORS.scaleWinningAd`).
 */
export const VIDEO_ONLY_SIGNALS: ReadonlySet<MetricField> = new Set([
  'thumbstopRate',
  'holdRate',
]);

/**
 * "Quanto do modelo esta plataforma permite cobrir?" (§12.2).
 *
 * Um componente é mensurável quando **ao menos um** dos seus sinais existe no
 * perfil. `attention` com `thumbstopRate` mas sem `holdRate` continua calculável
 * com menos evidência, e essa perda já aparece na `confidence` da calculadora.
 * Exigir todos os sinais confundiria "medido pior" com "não mensurável", que é a
 * distinção que DEC-2 existe para preservar.
 */
export function platformCoverageMaxFor(platform: Platform): number {
  return coverageMaxOver(new Set(platformProfile(platform).metrics.available));
}

/**
 * O mesmo teto, descontando os sinais de `VIDEO_ONLY_SIGNALS` — para o anúncio
 * cujo formato não produz vídeo (ver o porquê acima).
 *
 * Usado só no cálculo **por anúncio** (`coverage.ts`); o resumo declarativo de
 * `GET /ads` continua em `platformCoverageMaxFor`, que descreve a plataforma,
 * não um anúncio específico dela.
 */
export function nonVideoCoverageMaxFor(platform: Platform): number {
  return adCoverageMaxFor(platform, { hasVideoFormat: false });
}

/**
 * O teto **deste anúncio**: o da plataforma, descontando o que o anúncio não
 * tem como produzir.
 *
 * Duas razões estruturais, a mesma lógica: um carrossel não gera sinal de
 * vídeo (`attention`), e um anúncio otimizado para alcance, tráfego ou
 * engajamento não gera "aderência de conversão" (`audienceFit`) — não por
 * falta de dado, mas porque não buscou conversão. Cobrar esses pesos no piso
 * de cobertura deixaria o anúncio para sempre abaixo dele.
 */
export function adCoverageMaxFor(
  platform: Platform,
  input: { hasVideoFormat?: boolean; judgedByConversion?: boolean },
): number {
  const available = platformProfile(platform).metrics.available.filter(
    (signal) =>
      input.hasVideoFormat !== false || !VIDEO_ONLY_SIGNALS.has(signal),
  );
  const excluded = new Set<ScoreComponentName>(
    input.judgedByConversion === false ? ['audienceFit'] : [],
  );
  return coverageMaxOver(new Set(available), excluded);
}

function coverageMaxOver(
  available: ReadonlySet<MetricField>,
  excluded: ReadonlySet<ScoreComponentName> = new Set(),
): number {
  let total = 0;
  let measurable = 0;

  for (const [component, weight] of Object.entries(COMPONENT_WEIGHTS) as Array<
    [ScoreComponentName, number]
  >) {
    total += weight;
    if (excluded.has(component)) continue;
    const signals = COMPONENT_SIGNALS[component];
    if (signals.some((signal) => available.has(signal))) measurable += weight;
  }

  return total === 0 ? 0 : Math.round((measurable / total) * 10_000) / 10_000;
}
