import { dailyAverageOverLastDays } from '../baseline';
import type { AdWindowAggregate, FindingAmount } from '../detection-context';

/**
 * As **duas grandezas** de §10.1, derivadas de um fator só.
 *
 * | Grandeza | Direção | Pergunta |
 * |---|---|---|
 * | `incurredAmount` | passada | "quanto já queimei com este problema?" |
 * | `avoidableDailyAmount` | futura | "quanto queimo por dia se não fizer nada?" |
 *
 * A segunda é a que justifica a urgência, é o que a ação interrompe, e é a
 * **única comparável** com o impacto medido depois. Reportar só a primeira faz o
 * produto prometer uma recuperação que não existe: aquele dinheiro já foi.
 *
 * **Todo detector produz um fator em [0,1], nunca um valor.** É o que mantém a
 * dupla persistência monetária (R-M) coerente sem uma única conversão de câmbio
 * dentro do domínio: o mesmo fator multiplica o gasto na moeda da conta e na
 * moeda-base, que vieram lado a lado da série. Calcular um e converter o outro
 * exigiria `fx_rates` aqui — e só `currency` toca `fx_rates` (§16.10).
 */

/** A janela do "por dia": os últimos 7 dias, como §10.5 declara. */
export const AVOIDABLE_WINDOW_DAYS = 7;

export type FindingAmounts = {
  incurred: FindingAmount;
  avoidableDaily: FindingAmount;
};

/** Gasto médio diário dos últimos 7 dias, nas duas moedas. */
export function dailySpendOf(ad: AdWindowAggregate): FindingAmount {
  return {
    value: dailyAverageOverLastDays(
      ad.daily.map((point) => ({ date: point.date, value: point.spend })),
      AVOIDABLE_WINDOW_DAYS,
    ),
    valueBase: dailyAverageOverLastDays(
      ad.daily.map((point) => ({ date: point.date, value: point.spendBase })),
      AVOIDABLE_WINDOW_DAYS,
    ),
  };
}

/**
 * Aplica o fator ao gasto da janela (incorrido) e ao gasto diário (evitável).
 *
 * **Anúncio que não entrega tem evitável zero**, e essa é a linha mais fácil de
 * esquecer: um anúncio pausado ontem continua tendo desperdício incorrido — o
 * dinheiro saiu —, mas não há nada a interromper amanhã. Reportar evitável sobre
 * ele encheria a ordenação padrão (`avoidableDaily`) de anúncios que já estão
 * parados, empurrando para baixo os que estão queimando agora.
 */
export function amountsFrom(
  ad: AdWindowAggregate,
  factor: number,
): FindingAmounts {
  const clamped = clamp01(factor);
  const daily = dailySpendOf(ad);

  return {
    incurred: {
      value: round2(ad.spend * clamped),
      valueBase: round2(ad.spendBase * clamped),
    },
    avoidableDaily: ad.isDelivering
      ? {
          value: round2(daily.value * clamped),
          valueBase: round2(daily.valueBase * clamped),
        }
      : { value: 0, valueBase: 0 },
  };
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Dinheiro com duas casas. `Decimal(14,4)` acomoda; a tela mostra duas. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100) / 100;
}

/**
 * Dinheiro **no texto do diagnóstico**, que é lido por gente.
 *
 * Os diagnósticos interpolavam `spendBase.toFixed(2)` seguido do código ISO e
 * imprimiam `7307.17 BRL` na tela — ponto decimal de outra localidade e a moeda
 * como sigla, ao lado de cards que mostram `R$ 7.307,17` para o mesmo valor.
 *
 * Separado de `round2`, que é sobre **armazenar** o número: um é a coluna, o
 * outro é a frase, e unir os dois faria o formato de exibição vazar para o
 * banco.
 */
export function formatBase(value: number, baseCurrency: string): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: baseCurrency,
  }).format(value);
}
