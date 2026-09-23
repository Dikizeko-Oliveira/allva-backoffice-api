/**
 * A redistribuição de receita entre plataformas do Multicanais — **função pura**.
 *
 * **Nenhuma das três opções é atribuição.** Atribuição distribui crédito entre
 * pontos de contato de uma mesma jornada, e o sync não coleta jornada nenhuma:
 * o que existe é a receita que cada plataforma reporta sobre os próprios
 * anúncios, cada uma na janela de atribuição configurada na conta. As opções
 * mudam só a forma de dividir o total observado:
 *
 * | Valor (legado da API) | O que calcula |
 * |---|---|
 * | `last-click` | a receita como cada plataforma reporta. O nome é herdado: não é last-click entre canais |
 * | `linear` | o total observado dividido pela fatia de investimento de cada plataforma |
 * | `blended-attribution` | metade reportada, metade pela fatia de investimento |
 *
 * Os valores da API ficaram como estavam para não quebrar clientes. O que mudou
 * foi o cálculo, que tinha dois defeitos:
 *
 * 1. `linear` e `blended-attribution` caíam no mesmo ramo e davam o mesmo
 *    número, e a mistura era reaplicada a cada linha diária de anúncio: uma
 *    plataforma com N linhas tinha a receita reportada dividida por 2 N vezes.
 * 2. A soma lia `spend`/`revenue` na moeda de cada conta, enquanto o resto da
 *    tela lê a moeda-base. Contas em moedas diferentes eram somadas como se
 *    fossem a mesma unidade.
 *
 * A entrada agora são os totais por plataforma que o `AnalyticsAggregator` já
 * calcula em moeda-base, sem as linhas com câmbio pendente. **Invariante:** em
 * qualquer opção, a soma das plataformas é a receita total observada. A
 * redistribuição move receita de lugar; nunca cria nem some com ela.
 */

export type RevenueSplitModel = 'last-click' | 'linear' | 'blended-attribution';

export type PlatformSpendRevenue = {
  /** Em moeda-base. */
  spend: number;
  /** Em moeda-base. */
  revenue: number;
};

/** O peso da receita reportada na opção mista. O restante segue o investimento. */
export const BLENDED_REPORTED_WEIGHT = 0.5;

export function redistributeRevenue<P extends string>(
  byPlatform: Record<P, PlatformSpendRevenue>,
  model: RevenueSplitModel,
): Record<P, number> {
  const platforms = Object.keys(byPlatform) as P[];
  const reported = {} as Record<P, number>;
  for (const platform of platforms) {
    reported[platform] = byPlatform[platform].revenue;
  }

  if (model === 'last-click') return reported;

  const totalSpend = platforms.reduce(
    (sum, platform) => sum + byPlatform[platform].spend,
    0,
  );
  // Sem investimento não há fatia a usar como régua: a receita fica onde a
  // plataforma a reportou, em vez de ser dividida por zero.
  if (totalSpend <= 0) return reported;

  const totalRevenue = platforms.reduce(
    (sum, platform) => sum + reported[platform],
    0,
  );

  const out = {} as Record<P, number>;
  for (const platform of platforms) {
    const bySpendShare =
      totalRevenue * (byPlatform[platform].spend / totalSpend);
    out[platform] =
      model === 'linear'
        ? bySpendShare
        : BLENDED_REPORTED_WEIGHT * reported[platform] +
          (1 - BLENDED_REPORTED_WEIGHT) * bySpendShare;
  }
  return out;
}
