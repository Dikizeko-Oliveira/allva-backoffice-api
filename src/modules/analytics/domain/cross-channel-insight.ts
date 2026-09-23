import type { Platform } from 'src/modules/integrations/domain/entities/platform';
import { platformLabel } from 'src/modules/integrations/domain/entities/platform';

/**
 * O insight cross-channel — **função pura**.
 *
 * A pergunta: *há um canal entregando melhor que outro a ponto de valer mover
 * dinheiro entre os dois, e quanto isso renderia?*
 *
 * O card que consome isto vinha com o texto escrito à mão no frontend — uma
 * frase que afirmava uma diferença de ROAS, um valor em reais e um efeito sobre
 * o funil superior sem que nenhum dos três tivesse vindo de dado nenhum. Três
 * decisões de modelagem existem contra esse modo de errar:
 *
 * 1. **A projeção é aritmética declarada, não previsão.** `valor movido ×
 *    (ROAS do receptor − ROAS do doador)` assume retorno marginal igual ao
 *    médio, e essa premissa é falsa por construção: leilão satura, público tem
 *    teto. Por isso ela sai acompanhada de `assumptions[]` — a ressalva viaja
 *    junto com o número, e não fica a critério de quem renderiza.
 * 2. **O que não é mensurável não é afirmado.** "sem reduzir o alcance no funil
 *    superior" não sai daqui, e não sai porque não existe cálculo que sustente:
 *    a série é de gasto, receita e conversão por anúncio, e nada nela fala sobre
 *    alcance incremental de topo. Uma frase não falseável ao lado de dois
 *    números verdadeiros contamina os dois.
 * 3. **Sem par comparável, o insight se recusa — e diz por quê.** Um canal só,
 *    volume abaixo do piso ou diferença dentro do ruído devolvem `UNAVAILABLE`
 *    com motivo, nunca uma recomendação fraca. O card mostra a razão; um card
 *    vazio faria o usuário achar que a tela quebrou.
 *
 * **Não há campo de insight por IA**, pela mesma razão registrada em
 * `budget-pacing.ts`: P4 exige que a rota funcione com todos os providers fora,
 * e um texto que some sob falha transforma a mesma tela em duas experiências
 * sem o usuário saber por quê.
 */

/**
 * Quanto do investimento do doador a sugestão move.
 *
 * 10% é conservador de propósito, e o motivo é o mesmo que obriga
 * `assumptions[]`: quanto maior a fatia movida, mais longe do observado a
 * projeção opera. Mover 10% de um canal mantém o restante da veiculação
 * intacta como base de comparação para a janela seguinte — mover metade
 * destruiria a própria medição que validaria a decisão.
 */
export const REALLOCATION_SHIFT = 0.1;

/**
 * A diferença de ROAS abaixo da qual não se recomenda mover nada.
 *
 * ROAS oscila por leilão, sazonalidade e mix de criativo dentro de uma mesma
 * janela. Recomendar realocação com 4% de diferença é ruído promovido a
 * conselho — e um produto que aconselha sobre ruído ensina o usuário a ignorar
 * o card.
 */
export const MATERIAL_ROAS_GAP_PCT = 15;

/**
 * O piso de evidência de cada lado (P7).
 *
 * ROAS calculado sobre três conversões não descreve o canal, descreve três
 * eventos. O piso incide nos **dois** lados de propósito: no receptor porque é o
 * ROAS dele que multiplica o valor movido — é a ponta que **aumenta** gasto, e
 * §12.4 reserva o piso mais alto justamente para ela —, e no doador porque uma
 * receita subnotificada ali fabrica a diferença inteira.
 */
export const MIN_CONVERSIONS_PER_SIDE = 10;

/**
 * A fatia mínima do investimento total para um canal poder doar.
 *
 * Abaixo disso, 10% do gasto do doador é um valor sem consequência prática, e
 * a sugestão gastaria a atenção do usuário para mover trocados.
 */
export const MIN_DONOR_SPEND_SHARE = 0.05;

export type PlatformAggregate = {
  platform: Platform;
  spendBase: number;
  revenueBase: number;
  /** `null` só quando não houve gasto: sem denominador não há ROAS. */
  roas: number | null;
  conversions: number;
};

export type CrossChannelInsightInput = {
  platforms: PlatformAggregate[];
  totalSpendBase: number;
  totalRevenueBase: number;
  /** A moeda-base da organização. `null` bloqueia qualquer afirmação em dinheiro. */
  baseCurrency: string | null;
  periodDays: number;
  excludedPendingNormalization: number;
};

export type InsightUnavailableReason =
  /** Nenhum canal com gasto na janela. */
  | 'NO_DELIVERY'
  /** Um canal só — não há par a comparar. */
  | 'SINGLE_PLATFORM'
  /** Sem moeda-base declarada: um valor a mover não seria dinheiro em moeda nenhuma. */
  | 'CURRENCY_UNDECLARED'
  /** Nenhum canal registrou receita: não há ROAS a comparar. */
  | 'ROAS_NOT_RESOLVABLE'
  /** Menos de dois canais acima do piso de conversões ou de fatia de gasto. */
  | 'BELOW_EVIDENCE_FLOOR'
  /** Os canais entregam ROAS equivalente — a resposta é não realocar. */
  | 'NO_MATERIAL_GAP';

/** O que sustenta — ou impede — a afirmação. Vai junto nos dois casos. */
export type InsightEvidence = {
  periodDays: number;
  /** Canais com gasto na janela. */
  platformsDelivering: number;
  /** Quantos deles ficaram fora por piso de conversões ou de fatia de gasto. */
  platformsBelowFloor: number;
  /** Linhas que entraram como zero por taxa de câmbio ainda não coletada (M1). */
  excludedPendingNormalization: number;
  minConversionsPerSide: number;
  materialGapPct: number;
};

export type InsightSide = {
  platform: Platform;
  label: string;
  roas: number;
  spendBase: number;
  revenueBase: number;
  conversions: number;
  /** Fatia do investimento total da janela. */
  spendShare: number;
};

export type CrossChannelInsight =
  | {
      kind: 'REALLOCATION';
      baseCurrency: string;
      /** O canal que cede investimento — o de menor ROAS entre os comparáveis. */
      from: InsightSide;
      /** O canal que recebe — o de maior ROAS. */
      to: InsightSide;
      /**
       * Quanto o receptor entrega a mais, em pontos percentuais relativos.
       * `null` quando o doador não registrou receita: a razão não é definida, e
       * a comparação passa a ser absoluta (o texto reflete isso).
       */
      roasGapPct: number | null;
      shiftShare: number;
      shiftAmountBase: number;
      /** O ganho **incremental**, não a receita total. */
      projectedRevenueGainBase: number;
      currentRoas: number | null;
      /** O ROAS combinado se a realocação se sustentar. O gasto total não muda. */
      projectedRoas: number | null;
      headline: string;
      /** As ressalvas que a projeção carrega. Nunca vazio. */
      assumptions: string[];
      evidence: InsightEvidence;
    }
  | {
      kind: 'UNAVAILABLE';
      reason: InsightUnavailableReason;
      headline: string;
      evidence: InsightEvidence;
    };

function moneyFormatter(currency: string) {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    maximumFractionDigits: 0,
  });
}

function roasText(roas: number): string {
  return `${roas.toFixed(2).replace('.', ',')}x`;
}

/**
 * As ressalvas da projeção.
 *
 * Estão aqui, e não no frontend, porque são parte da afirmação: separar o número
 * do que ele pressupõe é como a primeira versão deste card chegou a prometer
 * receita sem nenhuma conta atrás.
 */
function assumptionsFor(receiverLabel: string): string[] {
  return [
    `A projeção mantém o ROAS observado de ${receiverLabel} sobre o investimento adicional. ` +
      'O retorno marginal costuma cair antes do médio.',
    'Não considera saturação de leilão, teto de público nem efeito de um canal sobre o outro.',
    'Receita observada na janela, sem modelo de atribuição causal entre canais.',
  ];
}

function unavailable(
  reason: InsightUnavailableReason,
  headline: string,
  evidence: InsightEvidence,
): CrossChannelInsight {
  return { kind: 'UNAVAILABLE', reason, headline, evidence };
}

export function computeCrossChannelInsight(
  input: CrossChannelInsightInput,
): CrossChannelInsight {
  const delivering = input.platforms.filter(
    (entry) => entry.spendBase > 0 && entry.roas !== null,
  );

  const comparable = delivering.filter(
    (entry) =>
      entry.conversions >= MIN_CONVERSIONS_PER_SIDE &&
      input.totalSpendBase > 0 &&
      entry.spendBase / input.totalSpendBase >= MIN_DONOR_SPEND_SHARE,
  );

  const evidence: InsightEvidence = {
    periodDays: input.periodDays,
    platformsDelivering: delivering.length,
    platformsBelowFloor: delivering.length - comparable.length,
    excludedPendingNormalization: input.excludedPendingNormalization,
    minConversionsPerSide: MIN_CONVERSIONS_PER_SIDE,
    materialGapPct: MATERIAL_ROAS_GAP_PCT,
  };

  const days = input.periodDays;

  if (delivering.length === 0) {
    return unavailable(
      'NO_DELIVERY',
      `Sem veiculação registrada nos últimos ${days} dias — não há canais a comparar.`,
      evidence,
    );
  }

  if (delivering.length === 1) {
    const only = platformLabel(delivering[0].platform);
    return unavailable(
      'SINGLE_PLATFORM',
      `${only} é o único canal com veiculação nos últimos ${days} dias. ` +
        'Comparar exige ao menos dois.',
      evidence,
    );
  }

  if (!input.baseCurrency) {
    return unavailable(
      'CURRENCY_UNDECLARED',
      'A moeda-base da organização não está declarada no período. Sem ela, um ' +
        'valor a realocar não é dinheiro em moeda nenhuma.',
      evidence,
    );
  }

  if (comparable.length < 2) {
    return unavailable(
      'BELOW_EVIDENCE_FLOOR',
      `Volume insuficiente para comparar canais nos últimos ${days} dias: são ` +
        `necessárias ao menos ${MIN_CONVERSIONS_PER_SIDE} conversões e ` +
        `${Math.round(MIN_DONOR_SPEND_SHARE * 100)}% do investimento em cada lado.`,
      evidence,
    );
  }

  const ranked = [...comparable].sort(
    (a, b) => (a.roas as number) - (b.roas as number),
  );
  const donor = ranked[0];
  const receiver = ranked[ranked.length - 1];
  const donorRoas = donor.roas as number;
  const receiverRoas = receiver.roas as number;

  // Conta de geração de lead sem valor de conversão: todo ROAS é zero, e a
  // diferença entre zeros não recomenda nada. Não é falta de dado — é falta de
  // receita registrada, e o texto diz qual das duas.
  if (receiverRoas <= 0) {
    return unavailable(
      'ROAS_NOT_RESOLVABLE',
      `Nenhum canal registrou receita nos últimos ${days} dias. Sem receita não ` +
        'há ROAS a comparar entre canais.',
      evidence,
    );
  }

  const roasGapPct =
    donorRoas > 0 ? ((receiverRoas - donorRoas) / donorRoas) * 100 : null;

  if (roasGapPct !== null && roasGapPct < MATERIAL_ROAS_GAP_PCT) {
    return unavailable(
      'NO_MATERIAL_GAP',
      `${platformLabel(receiver.platform)} e ${platformLabel(donor.platform)} ` +
        `entregam ROAS equivalente nos últimos ${days} dias — ` +
        `${roasGapPct.toFixed(0)}% de diferença, abaixo dos ` +
        `${MATERIAL_ROAS_GAP_PCT}% que justificariam realocar.`,
      evidence,
    );
  }

  const currency = input.baseCurrency;
  const money = moneyFormatter(currency);
  const shiftAmountBase = donor.spendBase * REALLOCATION_SHIFT;
  const projectedRevenueGainBase = shiftAmountBase * (receiverRoas - donorRoas);

  const currentRoas =
    input.totalSpendBase > 0
      ? input.totalRevenueBase / input.totalSpendBase
      : null;
  // O gasto total não muda numa realocação — só o denominador de cada canal.
  const projectedRoas =
    input.totalSpendBase > 0
      ? (input.totalRevenueBase + projectedRevenueGainBase) /
        input.totalSpendBase
      : null;

  const donorLabel = platformLabel(donor.platform);
  const receiverLabel = platformLabel(receiver.platform);
  const shiftPct = Math.round(REALLOCATION_SHIFT * 100);

  const comparison =
    roasGapPct === null
      ? `${donorLabel} não registrou receita nos últimos ${days} dias, ` +
        `enquanto ${receiverLabel} entrega ROAS de ${roasText(receiverRoas)}.`
      : `${receiverLabel} entrega ROAS ${roasGapPct.toFixed(0)}% maior que ` +
        `${donorLabel} nos últimos ${days} dias ` +
        `(${roasText(receiverRoas)} contra ${roasText(donorRoas)}).`;

  const headline =
    `${comparison} Realocar ${shiftPct}% do investimento de ${donorLabel} — ` +
    `${money.format(shiftAmountBase)} — projeta ` +
    `${money.format(projectedRevenueGainBase)} a mais em receita, mantido o ` +
    'ROAS observado no volume adicional.';

  const side = (entry: PlatformAggregate): InsightSide => ({
    platform: entry.platform,
    label: platformLabel(entry.platform),
    roas: entry.roas as number,
    spendBase: entry.spendBase,
    revenueBase: entry.revenueBase,
    conversions: entry.conversions,
    spendShare:
      input.totalSpendBase > 0 ? entry.spendBase / input.totalSpendBase : 0,
  });

  return {
    kind: 'REALLOCATION',
    baseCurrency: currency,
    from: side(donor),
    to: side(receiver),
    roasGapPct,
    shiftShare: REALLOCATION_SHIFT,
    shiftAmountBase,
    projectedRevenueGainBase,
    currentRoas,
    projectedRoas,
    headline,
    assumptions: assumptionsFor(receiverLabel),
    evidence,
  };
}
