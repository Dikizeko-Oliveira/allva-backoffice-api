import { buildBillingSchedule, resolveDueDate } from './billing-schedule';

/**
 * O cronograma de cobrança de um contrato.
 *
 * Três modelos, e o que os separa não é o valor: é **quantas** faturas a
 * vigência produz e **o que entra na primeira**. Errar isso cobra a mais de um
 * cliente ou entrega de graça para outro.
 */

const INICIO = new Date('2026-10-01T00:00:00Z');
const FIM_ANUAL = new Date('2027-09-30T23:59:59Z');

function contrato(
  overrides: Partial<Parameters<typeof buildBillingSchedule>[0]> = {},
) {
  return {
    startsAt: INICIO,
    endsAt: FIM_ANUAL,
    billingInterval: 'ANNUAL' as const,
    billingAmount: 48000,
    setupFeeAmount: null,
    ...overrides,
  };
}

describe('anual antecipado', () => {
  it('uma cobrança, do valor cheio, cobrindo a vigência', () => {
    const [cobranca, ...resto] = buildBillingSchedule(contrato());

    expect(resto).toHaveLength(0);
    expect(cobranca.amount).toBe(48000);
    expect(cobranca.periodStart).toEqual(INICIO);
    expect(cobranca.periodEnd).toEqual(FIM_ANUAL);
  });

  it('a implantação entra na mesma fatura', () => {
    const [cobranca] = buildBillingSchedule(contrato({ setupFeeAmount: 8000 }));

    expect(cobranca.amount).toBe(56000);
    expect(cobranca.kind).toBe('SETUP_AND_LICENSE');
  });
});

describe('mensal', () => {
  const mensal = contrato({ billingInterval: 'MONTHLY', billingAmount: 4000 });

  it('doze cobranças num contrato de doze meses', () => {
    /**
     * Compromisso anual cobrado mensalmente: doze faturas de R$ 4.000 não são
     * doze contratos de um mês, são um contrato de R$ 48.000 em doze vezes. O
     * que muda é a cobrança, não a vigência.
     */
    expect(buildBillingSchedule(mensal)).toHaveLength(12);
  });

  it('a implantação entra só na primeira', () => {
    const cobrancas = buildBillingSchedule({ ...mensal, setupFeeAmount: 8000 });

    expect(cobrancas[0].amount).toBe(12000);
    expect(cobrancas[0].kind).toBe('SETUP_AND_LICENSE');
    expect(cobrancas[1].amount).toBe(4000);
    expect(cobrancas[1].kind).toBe('LICENSE');
  });

  it('a última cobrança não ultrapassa o fim do contrato', () => {
    // Vigência quebrada de propósito: 45 dias não são dois meses cheios.
    const curto = {
      ...mensal,
      endsAt: new Date('2026-11-15T00:00:00Z'),
    };

    const cobrancas = buildBillingSchedule(curto);

    // Cobrar por um mês que a vigência não cobre é cobrar pelo que não se
    // entrega.
    expect(cobrancas.at(-1)!.periodEnd).toEqual(curto.endsAt);
  });

  it('acompanha a vigência, e não um número fixo de meses', () => {
    const dezoitoMeses = {
      ...mensal,
      endsAt: new Date('2028-03-31T00:00:00Z'),
    };

    // Contar doze aqui truncaria este contrato e inventaria cobrança num de
    // noventa dias.
    expect(buildBillingSchedule(dezoitoMeses).length).toBeGreaterThan(12);
  });
});

describe('vencimento pela condição negociada', () => {
  const emissao = new Date('2026-10-01T00:00:00Z');

  it('antecipado vence no dia', () => {
    // Dar prazo ao pagamento antecipado contradiria o que foi negociado.
    expect(resolveDueDate(emissao, 'UPFRONT')).toEqual(emissao);
  });

  it.each([
    ['NET_15', 15],
    ['NET_30', 30],
    ['NET_60', 60],
  ] as const)('%s vence em %i dias', (termo, dias) => {
    const esperado = new Date(emissao);
    esperado.setDate(esperado.getDate() + dias);

    expect(resolveDueDate(emissao, termo)).toEqual(esperado);
  });
});
