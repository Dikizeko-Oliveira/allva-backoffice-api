import {
  ContractBillingInterval,
  ContractPaymentTerms,
} from './entities/enterprise-contract.entity';

/** Uma cobrança a emitir: o período que ela cobre e o que ela cobra. */
export type ScheduledCharge = {
  periodStart: Date;
  periodEnd: Date;
  amount: number;
  /** O que a linha representa, para a fatura poder dizê-lo ao cliente. */
  kind: 'SETUP_AND_LICENSE' | 'LICENSE';
};

const DIAS_POR_TERMO: Record<ContractPaymentTerms, number> = {
  UPFRONT: 0,
  NET_15: 15,
  NET_30: 30,
  NET_60: 60,
};

/**
 * Quando a fatura vence, contado da emissão.
 *
 * `UPFRONT` vence no dia: é pagamento antecipado, e dar prazo a ele
 * contradiria o que foi negociado. Os demais são o "NET n" que o financeiro do
 * cliente pratica — trinta dias é o mais comum, e é por isso que travar o
 * acesso até a compensação transformaria a condição de pagamento em punição.
 */
export function resolveDueDate(
  issuedAt: Date,
  terms: ContractPaymentTerms,
): Date {
  const due = new Date(issuedAt);
  due.setDate(due.getDate() + DIAS_POR_TERMO[terms]);

  return due;
}

/**
 * O cronograma de cobrança de um contrato.
 *
 * ## Três modelos, e por que só três
 *
 * **Anual antecipado** é uma cobrança do valor cheio. **Mensal** divide a
 * vigência em cobranças de um mês — e o compromisso continua sendo anual: doze
 * faturas de R$ 4.000 não são doze contratos de um mês, são um contrato de
 * R$ 48.000 cobrado em doze vezes. **Setup mais recorrência** soma a
 * implantação à primeira fatura e some depois; é o que casa com onboarding
 * assistido sendo vendido junto.
 *
 * Preço por uso e parcelamento irregular ficaram de fora: o primeiro exige
 * medição de consumo que o produto ainda não tem, e o segundo é um cronograma
 * arbitrário que ninguém pediu. Ambos entram quando houver um contrato real
 * que os exija — e não antes, para não manter código que nada exercita.
 *
 * ## O que a função **não** decide
 *
 * Ela não emite nada. Devolve o que caberia emitir na vigência inteira, e quem
 * decide o que já venceu, o que já foi emitido e o que falta é o caso de uso —
 * que é quem conhece as faturas existentes.
 */
export function buildBillingSchedule(contract: {
  startsAt: Date;
  endsAt: Date;
  billingInterval: ContractBillingInterval;
  billingAmount: number;
  setupFeeAmount: number | null;
}): ScheduledCharge[] {
  const setup = contract.setupFeeAmount ?? 0;

  if (contract.billingInterval === 'ANNUAL') {
    return [
      {
        periodStart: contract.startsAt,
        periodEnd: contract.endsAt,
        amount: contract.billingAmount + setup,
        kind: setup > 0 ? 'SETUP_AND_LICENSE' : 'LICENSE',
      },
    ];
  }

  const charges: ScheduledCharge[] = [];
  let periodStart = new Date(contract.startsAt);
  let first = true;

  /**
   * O laço para no fim da vigência, e não num número fixo de meses: um contrato
   * de dezoito meses ou de noventa dias é a mesma regra, e contar doze aqui
   * silenciosamente truncaria o primeiro e inventaria cobrança no segundo.
   */
  while (periodStart < contract.endsAt) {
    const periodEnd = new Date(periodStart);
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    // A última cobrança nunca ultrapassa o fim do contrato: cobrar por um mês
    // que a vigência não cobre é cobrar pelo que não se entrega.
    const cappedEnd = periodEnd > contract.endsAt ? contract.endsAt : periodEnd;

    charges.push({
      periodStart: new Date(periodStart),
      periodEnd: cappedEnd,
      amount: contract.billingAmount + (first ? setup : 0),
      kind: first && setup > 0 ? 'SETUP_AND_LICENSE' : 'LICENSE',
    });

    periodStart = periodEnd;
    first = false;
  }

  return charges;
}
