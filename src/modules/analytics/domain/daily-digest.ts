import { createHash } from 'node:crypto';

/**
 * O resumo diário da organização — **P9 aplicado a um texto**.
 *
 * Três regras, e as três existem contra o mesmo modo de errar: *a IA entrar em
 * ação sempre que alguém abre a tela.*
 *
 * 1. **Os fatos são calculados primeiro e são a resposta.** A narrativa é
 *    enriquecimento (P4): provider fora, teto atingido ou chave ausente
 *    produzem `narrative: null` e o card continua inteiro. O que a IA faz é
 *    redigir o que já foi apurado — nunca apurar.
 * 2. **O digest é dos fatos, não do texto.** Fatos idênticos aos de ontem —
 *    conta parada, fim de semana sem veiculação — significam nenhuma chamada de
 *    provider: o texto anterior é copiado e a economia fica registrada.
 * 3. **O arredondamento entra no digest de propósito.** Sem ele, uma variação
 *    de centavos no gasto mudaria o hash todo dia e P9 nunca cortaria nada —
 *    a regra existiria no papel e a conta chegaria igual.
 */

export type DigestFacts = {
  periodDays: number;
  baseCurrency: string | null;

  spendBase: number;
  revenueBase: number;
  roas: number | null;
  /** Variação percentual contra o período anterior. `null` = sem base. */
  spendDelta: number | null;
  roasDelta: number | null;

  openWasteCount: number;
  affectedAds: number;
  avoidableDailyBase: number | null;

  pacingStatus: 'OVERSPENDING' | 'HEALTHY' | 'UNDERSPENDING' | null;
};

/**
 * A granularidade do hash.
 *
 * Dinheiro ao real e percentual ao ponto: abaixo disso é ruído de leilão, e um
 * digest sensível a ruído recalcularia todo dia — que é exatamente o
 * comportamento que este arquivo existe para impedir.
 */
function quantize(facts: DigestFacts): unknown[] {
  const money = (value: number | null) =>
    value === null ? null : Math.round(value);
  const percent = (value: number | null) =>
    value === null ? null : Math.round(value);

  return [
    facts.periodDays,
    facts.baseCurrency,
    money(facts.spendBase),
    money(facts.revenueBase),
    facts.roas === null ? null : Math.round(facts.roas * 10) / 10,
    percent(facts.spendDelta),
    percent(facts.roasDelta),
    facts.openWasteCount,
    facts.affectedAds,
    money(facts.avoidableDailyBase),
    facts.pacingStatus,
  ];
}

export function digestOf(facts: DigestFacts): string {
  return createHash('sha256')
    .update(JSON.stringify(quantize(facts)))
    .digest('hex');
}

/**
 * O resumo **sem IA** — e ele não é um placeholder.
 *
 * É o que o card mostra quando o provider está fora, quando o teto de custo foi
 * atingido, e quando não há chave configurada. Um texto que dissesse "resumo
 * indisponível" transformaria a ausência de um enriquecimento opcional em falha
 * do produto; P4 diz o contrário — sem uma única chamada de LLM, tudo continua
 * de pé.
 */
export function deterministicSummary(facts: DigestFacts): string {
  const parts: string[] = [];
  const money = (value: number) =>
    new Intl.NumberFormat('pt-BR', {
      style: 'currency',
      currency: facts.baseCurrency ?? 'BRL',
      maximumFractionDigits: 0,
    }).format(value);

  const trend =
    facts.spendDelta === null
      ? ''
      : facts.spendDelta > 0
        ? ` (${facts.spendDelta.toFixed(0)}% acima do período anterior)`
        : ` (${Math.abs(facts.spendDelta).toFixed(0)}% abaixo do período anterior)`;

  parts.push(
    `Nos últimos ${facts.periodDays} dias você investiu ${money(facts.spendBase)}${trend}.`,
  );

  if (facts.roas !== null) {
    const roasTrend =
      facts.roasDelta === null
        ? ''
        : facts.roasDelta > 0
          ? `, ${facts.roasDelta.toFixed(0)}% melhor que no período anterior`
          : `, ${Math.abs(facts.roasDelta).toFixed(0)}% pior que no período anterior`;

    parts.push(
      `O ROAS combinado ficou em ${facts.roas.toFixed(2)}x${roasTrend}.`,
    );
  }

  if (facts.openWasteCount > 0 && facts.avoidableDailyBase !== null) {
    parts.push(
      `Há ${facts.openWasteCount} achado(s) aberto(s) em ${facts.affectedAds} anúncio(s), ` +
        `com ${money(facts.avoidableDailyBase)} por dia que dá para interromper.`,
    );
  } else if (facts.openWasteCount === 0) {
    parts.push('Nenhum desperdício aberto na última varredura.');
  }

  if (facts.pacingStatus === 'OVERSPENDING') {
    parts.push(
      'O gasto está acima do que o teto diário das campanhas permitia.',
    );
  } else if (facts.pacingStatus === 'UNDERSPENDING') {
    parts.push('O gasto ficou abaixo do teto diário declarado nas campanhas.');
  }

  return parts.join(' ');
}
