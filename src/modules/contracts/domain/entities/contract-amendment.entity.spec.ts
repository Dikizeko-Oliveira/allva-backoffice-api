import { ContractAmendment, AmendmentError } from './contract-amendment.entity';

/**
 * O aditivo — uma alteração acordada no meio da vigência.
 *
 * O que ele resolve não é "mudar um número": é registrar que a mudança foi
 * negociada, quando passa a valer e o que havia antes. Sem esse registro,
 * expandir de 150 para 250 assentos vira um `UPDATE` que apaga o que o cliente
 * tinha contratado — e o comercial perde a informação que justifica a
 * cobrança nova.
 */

const DIA = 24 * 60 * 60 * 1000;
const AGORA = new Date('2026-09-04T12:00:00Z');

const SEM_MUDANCA = {
  billingAmount: null,
  maxSeats: null,
  maxAdAccounts: null,
  maxMonitoredAds: null,
  maxOrganizations: null,
  llmDailyBudgetBase: null,
};

function aditivo(
  overrides: Partial<Parameters<typeof ContractAmendment.create>[0]> = {},
) {
  return ContractAmendment.create({
    contractId: 'contract-1',
    organizationId: 'org-1',
    number: 'ENT-2026-0012/A1',
    effectiveAt: AGORA,
    reason: 'Expansão de equipe acordada em reunião trimestral',
    createdBy: 'operator-1',
    changes: { ...SEM_MUDANCA, maxSeats: 250 },
    ...overrides,
  });
}

describe('o que um aditivo precisa dizer', () => {
  it('nasce pendente, mesmo quando a data já chegou', () => {
    // Criar e aplicar são passos separados: aplicar escreve na cota da
    // organização, e isso é transação de quem tem o repositório na mão.
    expect(aditivo().appliedAt).toBeNull();
  });

  it('recusa um aditivo que não muda nada', () => {
    /**
     * Cinco nulos é um documento sem conteúdo. Aceitá-lo encheria o histórico
     * do cliente de linhas que não explicam nada, e a primeira pergunta de
     * quem abrisse seria "o que mudou aqui?".
     */
    expect(() => aditivo({ changes: SEM_MUDANCA })).toThrow(AmendmentError);
  });

  it('recusa um motivo vazio', () => {
    // O motivo é o que o operador lê seis meses depois para lembrar por que a
    // cobrança mudou.
    expect(() => aditivo({ reason: '   ' })).toThrow(AmendmentError);
  });

  it('recusa valor negociado igual ou abaixo de zero', () => {
    expect(() =>
      aditivo({ changes: { ...SEM_MUDANCA, billingAmount: 0 } }),
    ).toThrow(AmendmentError);
  });

  it('recusa teto zerado', () => {
    // Zero assentos não é uma redução: é uma conta fechada, e isso se faz
    // suspendendo ou cancelando o contrato, não aditando.
    expect(() => aditivo({ changes: { ...SEM_MUDANCA, maxSeats: 0 } })).toThrow(
      AmendmentError,
    );
  });
});

describe('quando o aditivo passa a valer', () => {
  it('vencido e não aplicado: está devendo aplicação', () => {
    const passado = aditivo({ effectiveAt: new Date(AGORA.getTime() - DIA) });

    expect(passado.isDue(AGORA)).toBe(true);
  });

  it('no instante exato da vigência já vale', () => {
    expect(aditivo().isDue(AGORA)).toBe(true);
  });

  it('datado para o futuro espera', () => {
    const futuro = aditivo({
      effectiveAt: new Date(AGORA.getTime() + 30 * DIA),
    });

    /**
     * É assim que se negocia: "a partir de janeiro passam a ser 250 assentos".
     * Aplicar na assinatura entregaria — e cobraria — um mês que o cliente não
     * contratou.
     */
    expect(futuro.isDue(AGORA)).toBe(false);
  });

  it('aplicado não volta a vencer', () => {
    const a = aditivo();
    a.markApplied(
      {
        maxSeats: 150,
        maxAdAccounts: null,
        maxMonitoredAds: null,
        maxOrganizations: null,
        llmDailyBudgetBase: null,
        billingAmount: null,
      },
      AGORA,
    );

    // O job varre todo dia; sem isto, ele reaplicaria o mesmo aditivo para
    // sempre e o "antes" seria sobrescrito pelo "depois".
    expect(a.isDue(new Date(AGORA.getTime() + DIA))).toBe(false);
  });
});

describe('o antes e o depois', () => {
  it('a aplicação carimba o que havia', () => {
    const a = aditivo();

    a.markApplied(
      {
        maxSeats: 150,
        maxAdAccounts: 20,
        maxMonitoredAds: null,
        maxOrganizations: null,
        llmDailyBudgetBase: null,
        billingAmount: 48000,
      },
      AGORA,
    );

    // "De 150 para 250" é o que o comercial precisa ler. Sem o carimbo, o
    // aditivo diria só "250" e o antes teria sumido.
    expect(a.previous.maxSeats).toBe(150);
    expect(a.changes.maxSeats).toBe(250);
    expect(a.appliedAt).toEqual(AGORA);
  });

  it('aplicar duas vezes é recusado', () => {
    const a = aditivo();
    const antes = { ...SEM_MUDANCA, maxSeats: 150 };

    a.markApplied(antes, AGORA);

    /**
     * A segunda aplicação carimbaria 250 como "o que havia antes", porque é o
     * que o contrato já mostra — e o registro do que o cliente tinha estaria
     * perdido. Recusar é o que torna o job seguro para rodar de novo.
     */
    expect(() => a.markApplied(antes, AGORA)).toThrow(AmendmentError);
  });

  it('só carimba as dimensões que o aditivo toca', () => {
    const a = aditivo();

    a.markApplied({ ...SEM_MUDANCA, maxSeats: 150, maxAdAccounts: 20 }, AGORA);

    // `maxAdAccounts` não estava no aditivo: guardar o valor anterior dele
    // sugeriria que foi negociado e não foi.
    expect(a.previous.maxAdAccounts).toBeNull();
  });
});

describe('o resultado que a cota recebe', () => {
  it('sobrepõe só o que mudou', () => {
    const a = aditivo({
      changes: { ...SEM_MUDANCA, maxSeats: 250, maxAdAccounts: 40 },
    });

    const resultado = a.applyTo({
      maxSeats: 150,
      maxAdAccounts: 20,
      maxMonitoredAds: 500,
      maxOrganizations: 3,
      llmDailyBudgetBase: null,
    });

    expect(resultado).toEqual({
      maxSeats: 250,
      maxAdAccounts: 40,
      // Intocados: nulo no aditivo significa "inalterado", e não "herda o
      // plano" — que é o que nulo quer dizer no contrato.
      maxMonitoredAds: 500,
      maxOrganizations: 3,
      llmDailyBudgetBase: null,
    });
  });
});
