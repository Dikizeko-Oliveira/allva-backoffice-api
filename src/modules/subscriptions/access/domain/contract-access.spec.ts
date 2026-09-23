import { resolveContractAccess } from './contract-access';

/**
 * A dimensão de vigência do acesso Enterprise.
 *
 * A assinatura de uma organização sob contrato nasce `ACTIVE` e **sem data** —
 * de propósito, para não duplicar a vigência em duas casas. O preço disso é que
 * o `ACTIVE` da assinatura, sozinho, concederia acesso para sempre: é esta
 * função que fecha a porta na data certa.
 *
 * Avaliada na leitura, e é o que a torna independente de job: um contrato que
 * venceu ontem à noite não concede acesso hoje de manhã porque nada rodou no
 * meio.
 */

const DIA = 24 * 60 * 60 * 1000;
const AGORA = new Date('2026-09-03T12:00:00Z');

function contrato(
  overrides: Partial<Parameters<typeof resolveContractAccess>[0]> = {},
) {
  return {
    status: 'ACTIVE',
    startsAt: new Date(AGORA.getTime() - 30 * DIA),
    endsAt: new Date(AGORA.getTime() + 335 * DIA),
    gracePeriodDays: 7,
    oldestUnpaidDueAt: null,
    ...overrides,
  };
}

describe('acesso concedido pela vigência do contrato', () => {
  it('dentro do prazo, ativo: concede', () => {
    expect(resolveContractAccess(contrato(), AGORA)).toBe('ALLOWED');
  });

  it('antes de a vigência começar: espera, não bloqueia', () => {
    const futuro = contrato({
      startsAt: new Date(AGORA.getTime() + 10 * DIA),
      endsAt: new Date(AGORA.getTime() + 375 * DIA),
    });

    // Contrato assinado com início no mês que vem é um cliente, não um
    // problema — e a tela de contratação é quem responde nesse intervalo.
    expect(resolveContractAccess(futuro, AGORA)).toBe('PENDING_ACTIVATION');
  });

  it('depois de a vigência terminar: pede renovação', () => {
    const vencido = contrato({
      startsAt: new Date(AGORA.getTime() - 400 * DIA),
      endsAt: new Date(AGORA.getTime() - 1 * DIA),
    });

    expect(resolveContractAccess(vencido, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('no último dia da vigência ainda concede', () => {
    const ultimoDia = contrato({
      endsAt: new Date(AGORA.getTime() + 1000),
    });

    // A borda importa: o cliente pagou até o fim do período, e fechar algumas
    // horas antes seria cobrar por um dia que não se entregou.
    expect(resolveContractAccess(ultimoDia, AGORA)).toBe('ALLOWED');
  });

  it('suspenso: fecha, com saída comercial', () => {
    expect(
      resolveContractAccess(contrato({ status: 'SUSPENDED' }), AGORA),
    ).toBe('PAYMENT_REQUIRED');
  });

  it('estado que não é ACTIVE nem os vivos conhecidos: fecha', () => {
    /**
     * Contrato morto não chega aqui: o read model traz só os vivos, e cancelar
     * revoga a assinatura da organização junto. A defesa existe para o caso de
     * um estado atravessar as duas coisas — conceder acesso por um acordo que
     * ninguém sabe descrever seria o erro caro.
     */
    expect(resolveContractAccess(contrato({ status: 'CANCELED' }), AGORA)).toBe(
      'PAYMENT_REQUIRED',
    );
  });

  it('esperando a primeira baixa: espera', () => {
    expect(
      resolveContractAccess(contrato({ status: 'PENDING_ACTIVATION' }), AGORA),
    ).toBe('PENDING_ACTIVATION');
  });

  it('assinado e ainda não ativado: espera', () => {
    expect(resolveContractAccess(contrato({ status: 'SIGNED' }), AGORA)).toBe(
      'PENDING_ACTIVATION',
    );
  });

  it('o estado comercial vence o calendário', () => {
    // Suspenso dentro do prazo continua suspenso: a data não regulariza uma
    // inadimplência.
    expect(
      resolveContractAccess(contrato({ status: 'SUSPENDED' }), AGORA),
    ).toBe('PAYMENT_REQUIRED');
  });
});

/**
 * A dimensão de pagamento — o outro eixo, e o que a torna diferente do
 * autoatendimento.
 *
 * No Stripe o provedor avisa quando o cartão falha. Aqui não há provedor: o
 * cliente paga por boleto, PIX ou transferência, e a única evidência de
 * inadimplência é uma fatura que passou do vencimento sem baixa. É por isso que
 * a régua é a data da fatura mais antiga em aberto, e não um status.
 *
 * A tolerância é negociada por contrato (`gracePeriodDays`). Fechar o produto
 * no dia seguinte ao vencimento seria tratar o financeiro de uma empresa como
 * um cartão recusado — o boleto compensa em dois dias úteis, e a conciliação
 * atrasa.
 */
describe('acesso recusado pela fatura em aberto', () => {
  const vencidaHa = (dias: number) => new Date(AGORA.getTime() - dias * DIA);

  it('sem fatura vencida: concede', () => {
    expect(resolveContractAccess(contrato(), AGORA)).toBe('ALLOWED');
  });

  it('fatura em aberto ainda dentro do prazo: concede', () => {
    // Emitida com NET_30, faltando uma semana para vencer. Não é
    // inadimplência: é a condição de pagamento que foi negociada.
    const aVencer = contrato({
      oldestUnpaidDueAt: new Date(AGORA.getTime() + 7 * DIA),
    });

    expect(resolveContractAccess(aVencer, AGORA)).toBe('ALLOWED');
  });

  it('vencida dentro da tolerância: avisa, não fecha', () => {
    const atrasada = contrato({ oldestUnpaidDueAt: vencidaHa(3) });

    // `GRACE_PERIOD` mantém o produto aberto e deixa o aviso aparecer — que é
    // o que dá ao comercial a chance de ligar antes de o cliente esbarrar numa
    // porta fechada.
    expect(resolveContractAccess(atrasada, AGORA)).toBe('GRACE_PERIOD');
  });

  it('no último dia da tolerância ainda concede', () => {
    const limite = contrato({ oldestUnpaidDueAt: vencidaHa(7) });

    // A borda importa porque a tolerância foi negociada: uma semana significa
    // sete dias, e fechar no sétimo entregaria um a menos do que o combinado.
    expect(resolveContractAccess(limite, AGORA)).toBe('GRACE_PERIOD');
  });

  it('o último dia inteiro conta, não o instante exato', () => {
    /**
     * O caso que um ensaio contra o banco pegou e o teste da borda não pegava:
     * comparar as durações cruas fecha o acesso alguns milissegundos depois de
     * completar a tolerância, e a igualdade exata só existe num teste que
     * constrói as duas datas do mesmo número. Na prática o cliente recebia
     * seis dias de uma tolerância de sete.
     */
    const limite = contrato({
      oldestUnpaidDueAt: new Date(AGORA.getTime() - 7 * DIA - 5),
    });

    expect(resolveContractAccess(limite, AGORA)).toBe('GRACE_PERIOD');
  });

  it('mas o dia seguinte ao último já fecha', () => {
    const passou = contrato({
      oldestUnpaidDueAt: new Date(AGORA.getTime() - 8 * DIA - 5),
    });

    expect(resolveContractAccess(passou, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('passada a tolerância: fecha', () => {
    const inadimplente = contrato({ oldestUnpaidDueAt: vencidaHa(8) });

    expect(resolveContractAccess(inadimplente, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('tolerância zero fecha no dia seguinte ao vencimento', () => {
    const semGraca = contrato({
      gracePeriodDays: 0,
      oldestUnpaidDueAt: vencidaHa(1),
    });

    // Contrato negociado com pré-pagamento estrito: a tolerância é um número
    // do acordo, e o resolver honra o que foi escrito nele — inclusive zero.
    expect(resolveContractAccess(semGraca, AGORA)).toBe('PAYMENT_REQUIRED');
  });

  it('a inadimplência não antecipa o início da vigência', () => {
    const futuroDevendo = contrato({
      startsAt: new Date(AGORA.getTime() + 10 * DIA),
      endsAt: new Date(AGORA.getTime() + 375 * DIA),
      oldestUnpaidDueAt: vencidaHa(30),
    });

    /**
     * Um contrato pré-pago que ainda não começou tem, por definição, fatura
     * vencida sem baixa — é exatamente o que se espera dele. Responder
     * `PAYMENT_REQUIRED` aqui trocaria "aguardando o início" por "você está
     * inadimplente", e mandaria o cliente para a tela errada.
     */
    expect(resolveContractAccess(futuroDevendo, AGORA)).toBe(
      'PENDING_ACTIVATION',
    );
  });

  it('a fatura em aberto não reabre um contrato suspenso', () => {
    const suspenso = contrato({
      status: 'SUSPENDED',
      oldestUnpaidDueAt: vencidaHa(2),
    });

    // Dentro da tolerância, mas suspenso: o estado comercial vence, e a
    // suspensão não vira aviso amarelo por causa do calendário.
    expect(resolveContractAccess(suspenso, AGORA)).toBe('PAYMENT_REQUIRED');
  });
});
