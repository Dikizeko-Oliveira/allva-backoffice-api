import {
  ContractTransitionError,
  EnterpriseContract,
  type CreateContractProps,
} from './enterprise-contract.entity';

/**
 * As transições do contrato — e sobretudo as **recusadas**.
 *
 * Uma máquina de estados que só é testada pelo caminho feliz não é uma máquina
 * de estados: é uma sequência de atribuições. O que ela existe para impedir é
 * ativar um contrato cancelado, suspender um que nunca abriu, encerrar uma
 * vigência que não terminou — e reabrir por pagamento algo que uma pessoa
 * fechou de propósito.
 */

const DIA = 24 * 60 * 60 * 1000;
const HOJE = new Date('2026-09-03T12:00:00Z');

function props(
  overrides: Partial<CreateContractProps> = {},
): CreateContractProps {
  return {
    contractNumber: 'ENT-2026-0012',
    salesLeadId: 'lead-1',
    planId: 'plan-enterprise',
    startsAt: new Date(HOJE.getTime() - 1 * DIA),
    endsAt: new Date(HOJE.getTime() + 364 * DIA),
    billingInterval: 'ANNUAL',
    billingAmount: 48000,
    setupFeeAmount: null,
    currency: 'BRL',
    paymentTerms: 'NET_30',
    paymentMethod: 'BOLETO',
    activateOnSignature: true,
    gracePeriodDays: 7,
    autoRenew: false,
    limits: {
      maxSeats: 150,
      maxAdAccounts: 30,
      maxMonitoredAds: null,
      maxOrganizations: null,
      llmDailyBudgetBase: null,
    },
    signedAt: new Date(HOJE.getTime() - 2 * DIA),
    signedDocumentUrl: null,
    ...overrides,
  };
}

/** Um contrato já ativo, que é o ponto de partida da maioria das transições. */
function ativo(overrides: Partial<CreateContractProps> = {}) {
  const contract = EnterpriseContract.create(props(overrides));
  contract.activate(HOJE);
  contract.linkOrganization('org-1');
  return contract;
}

describe('EnterpriseContract — criação', () => {
  it('nasce em SIGNED, sem organização', () => {
    const contract = EnterpriseContract.create(props());

    expect(contract.status).toBe('SIGNED');
    expect(contract.organizationId).toBeNull();
    expect(contract.activatedAt).toBeNull();
  });

  it('recusa vigência invertida', () => {
    expect(() =>
      EnterpriseContract.create(
        props({
          startsAt: new Date('2026-12-01'),
          endsAt: new Date('2026-06-01'),
        }),
      ),
    ).toThrow(ContractTransitionError);
  });

  it('recusa valor zerado — contrato negociado tem preço', () => {
    expect(() =>
      EnterpriseContract.create(props({ billingAmount: 0 })),
    ).toThrow(ContractTransitionError);
  });
});

describe('EnterpriseContract — ativação', () => {
  it('abre o acesso na assinatura quando foi o que se negociou', () => {
    const contract = EnterpriseContract.create(props());

    contract.activate(HOJE);
    contract.linkOrganization('org-1');

    expect(contract.status).toBe('ACTIVE');
    expect(contract.organizationId).toBe('org-1');
    expect(contract.activatedAt).toEqual(HOJE);
  });

  it('espera a primeira baixa quando o pré-pagamento foi exigido', () => {
    const contract = EnterpriseContract.create(
      props({ activateOnSignature: false }),
    );

    contract.activate(HOJE);
    contract.linkOrganization('org-1');

    // A organização foi provisionada; o acesso é que ainda não abriu.
    expect(contract.status).toBe('PENDING_ACTIVATION');
    expect(contract.organizationId).toBe('org-1');
    expect(contract.grantsAccess(HOJE)).toBe(false);
  });

  it('a primeira baixa abre o acesso de quem esperava', () => {
    const contract = EnterpriseContract.create(
      props({ activateOnSignature: false }),
    );
    contract.activate(HOJE);
    contract.linkOrganization('org-1');

    contract.confirmFirstPayment();

    expect(contract.status).toBe('ACTIVE');
  });

  it('não confirma pagamento de contrato que já está ativo', () => {
    const contract = ativo();

    expect(() => contract.confirmFirstPayment()).toThrow(
      ContractTransitionError,
    );
  });

  it('ativar de novo não é erro nem reprovisiona', () => {
    const contract = ativo();

    // A cadeia inteira é idempotente; recusar aqui obrigaria quem chama a
    // distinguir "já estava pronto" de "falhou".
    contract.activate(HOJE);
    contract.linkOrganization('org-OUTRA');

    // E a organização já ligada não é trocada: apontar o contrato para outra
    // seria trocar a fronteira de dado do cliente.
    expect(contract.organizationId).toBe('org-1');
    expect(contract.status).toBe('ACTIVE');
  });

  it('não ativa um contrato cancelado', () => {
    const contract = EnterpriseContract.create(props());
    contract.cancel(HOJE);

    expect(() => contract.activate(HOJE)).toThrow(ContractTransitionError);
  });
});

describe('EnterpriseContract — suspensão e reativação', () => {
  it('não suspende um contrato que nunca abriu', () => {
    const contract = EnterpriseContract.create(props());

    expect(() => contract.suspend({ reason: 'NON_PAYMENT' })).toThrow(
      ContractTransitionError,
    );
  });

  it('a baixa reabre o que a inadimplência fechou', () => {
    const contract = ativo();
    contract.suspend({ reason: 'NON_PAYMENT', now: HOJE });

    expect(contract.reactivateOnPayment()).toBe(true);
    expect(contract.status).toBe('ACTIVE');
    expect(contract.suspendedReason).toBeNull();
  });

  it('a baixa NÃO reabre o que o operador fechou', () => {
    const contract = ativo();
    contract.suspend({ reason: 'OPERATOR', now: HOJE });

    /**
     * O caso que motiva `suspendedReason` existir. Quebra de contrato, fraude
     * ou disputa não se desfazem porque um pagamento entrou — e reabrir em
     * silêncio significaria descobrir pelo cliente usando o produto de novo.
     */
    expect(contract.reactivateOnPayment()).toBe(false);
    expect(contract.status).toBe('SUSPENDED');
  });

  it('o operador reabre o que o operador fechou', () => {
    const contract = ativo();
    contract.suspend({ reason: 'OPERATOR', now: HOJE });

    contract.reactivateByOperator();

    expect(contract.status).toBe('ACTIVE');
    expect(contract.suspendedAt).toBeNull();
  });

  it('não reativa o que não está suspenso', () => {
    const contract = ativo();

    expect(() => contract.reactivateByOperator()).toThrow(
      ContractTransitionError,
    );
  });
});

describe('EnterpriseContract — fim da vigência', () => {
  it('não encerra uma vigência que ainda corre', () => {
    const contract = ativo();

    /**
     * Fato do calendário, e não decisão: recusar antes da data impede que um
     * job com relógio errado encerre um contrato vigente.
     */
    expect(() => contract.markExpired(HOJE)).toThrow(ContractTransitionError);
  });

  it('encerra depois de a data passar', () => {
    const contract = ativo();
    const depois = new Date(HOJE.getTime() + 400 * DIA);

    contract.markExpired(depois);

    expect(contract.status).toBe('EXPIRED');
  });

  it('não cancela o que já expirou', () => {
    const contract = ativo();
    contract.markExpired(new Date(HOJE.getTime() + 400 * DIA));

    expect(() => contract.cancel()).toThrow(ContractTransitionError);
  });
});

describe('EnterpriseContract — o acesso que ele concede sozinho', () => {
  it('concede dentro da vigência, estando ativo', () => {
    expect(ativo().grantsAccess(HOJE)).toBe(true);
  });

  it('não concede antes de a vigência começar', () => {
    const contract = ativo({
      startsAt: new Date(HOJE.getTime() + 10 * DIA),
      endsAt: new Date(HOJE.getTime() + 375 * DIA),
    });

    expect(contract.grantsAccess(HOJE)).toBe(false);
  });

  it('não concede depois de a vigência terminar, mesmo sem ninguém ter carimbado EXPIRED', () => {
    const contract = ativo();
    const depois = new Date(HOJE.getTime() + 400 * DIA);

    // É o que torna o job dispensável para a decisão de acesso: a leitura já
    // sabe, sem esperar alguém persistir o estado.
    expect(contract.grantsAccess(depois)).toBe(false);
  });

  it('não concede suspenso nem cancelado', () => {
    const suspenso = ativo();
    suspenso.suspend({ reason: 'NON_PAYMENT', now: HOJE });
    expect(suspenso.grantsAccess(HOJE)).toBe(false);

    const cancelado = ativo();
    cancelado.cancel(HOJE);
    expect(cancelado.grantsAccess(HOJE)).toBe(false);
  });
});

/**
 * O aditivo aplicado ao contrato.
 *
 * O aditivo é o documento; o contrato é onde os termos vigentes moram. Sem
 * escrever aqui, o contrato diria 150 assentos enquanto a organização opera com
 * 250 — as duas casas divergindo, que é exatamente o que a vigência única
 * evitou desde o começo.
 */
describe('aplicar um aditivo', () => {
  const EXPANSAO = {
    billingAmount: 72000,
    maxSeats: 250,
    maxAdAccounts: null,
    maxMonitoredAds: null,
    maxOrganizations: null,
    llmDailyBudgetBase: null,
  };

  it('reescreve os termos vigentes', () => {
    const c = ativo();

    c.applyAmendment(EXPANSAO);

    expect(c.limits.maxSeats).toBe(250);
    expect(c.billingAmount).toBe(72000);
  });

  it('não toca no que o aditivo não menciona', () => {
    const c = ativo();
    const antes = c.limits.maxAdAccounts;

    c.applyAmendment(EXPANSAO);

    // Nulo no aditivo é "inalterado". Tratá-lo como "herda o plano" — que é o
    // que nulo significa no contrato — zeraria um teto que ninguém renegociou.
    expect(c.limits.maxAdAccounts).toBe(antes);
  });

  it('recusa aditivo em contrato que ainda não foi ativado', () => {
    const c = EnterpriseContract.create(props());

    /**
     * Antes da ativação não há nada provisionado, e mudança é correção: se
     * edita o contrato. Abrir o aditivo aqui daria dois caminhos para a mesma
     * coisa, e o histórico do cliente passaria a conter documentos que só
     * consertam digitação.
     */
    expect(() => c.applyAmendment(EXPANSAO)).toThrow(ContractTransitionError);
  });

  it('recusa aditivo em contrato encerrado', () => {
    const c = ativo();
    c.cancel();

    expect(() => c.applyAmendment(EXPANSAO)).toThrow(ContractTransitionError);
  });

  it('um contrato suspenso ainda aceita aditivo', () => {
    const c = ativo();
    c.suspend({ reason: 'NON_PAYMENT' });

    /**
     * Renegociar é justamente o que se faz com um cliente inadimplente — baixar
     * o valor para ele conseguir pagar. Recusar aqui obrigaria o operador a
     * reativar primeiro, concedendo acesso que a negociação ainda não fechou.
     */
    expect(() => c.applyAmendment(EXPANSAO)).not.toThrow();
    expect(c.status).toBe('SUSPENDED');
  });
});

/**
 * A renovação — o contrato seguinte, e a cadeia que ele preserva.
 *
 * O que ela não pode fazer é abrir um buraco: o cliente que renovou cedo não
 * pode perder acesso no dia da assinatura, e o antigo não pode morrer antes de
 * a vigência dele terminar.
 */
describe('renovar', () => {
  const PROXIMO_TERMO = {
    startsAt: new Date(HOJE.getTime() + 364 * DIA),
    endsAt: new Date(HOJE.getTime() + 729 * DIA),
    signedAt: HOJE,
  };

  it('o sucessor herda os termos e aponta para o anterior', () => {
    const atual = ativo();

    const proximo = atual.renewInto({
      ...PROXIMO_TERMO,
      contractNumber: 'ENT-2027-0001',
    });

    expect(proximo.renewedFromId).toBe(atual.id);
    expect(proximo.planId).toBe(atual.planId);
    expect(proximo.salesLeadId).toBe(atual.salesLeadId);
    expect(proximo.billingAmount).toBe(atual.billingAmount);
    expect(proximo.limits).toEqual(atual.limits);
  });

  it('o sucessor já nasce ligado à mesma organização', () => {
    const atual = ativo();

    const proximo = atual.renewInto({
      ...PROXIMO_TERMO,
      contractNumber: 'ENT-2027-0001',
    });

    /**
     * Renovar não provisiona nada: a empresa já é cliente. Deixar o sucessor
     * sem organização faria a ativação dele procurar uma para criar — e a
     * regra de reuso é uma rede, não um lugar para se apoiar.
     */
    expect(proximo.organizationId).toBe('org-1');
  });

  it('o que foi renegociado sobrepõe o herdado', () => {
    const atual = ativo();

    const proximo = atual.renewInto({
      ...PROXIMO_TERMO,
      contractNumber: 'ENT-2027-0001',
      billingAmount: 60000,
      limits: { ...atual.limits, maxSeats: 300 },
    });

    expect(proximo.billingAmount).toBe(60000);
    expect(proximo.limits.maxSeats).toBe(300);
    // Não renegociado continua como estava.
    expect(proximo.limits.maxAdAccounts).toBe(atual.limits.maxAdAccounts);
  });

  it('o contrato atual **não** morre na assinatura da renovação', () => {
    const atual = ativo();

    atual.renewInto({ ...PROXIMO_TERMO, contractNumber: 'ENT-2027-0001' });

    /**
     * O passo que fecharia o acesso. A renovação é assinada meses antes de
     * começar, e marcar o atual como `RENEWED` na assinatura o tiraria da
     * leitura de acesso — deixando o cliente sem contrato vigente até a virada.
     * Quem o encerra é o fim da vigência dele.
     */
    expect(atual.status).toBe('ACTIVE');
  });

  it('recusa uma vigência que começa antes de a atual terminar', () => {
    const atual = ativo();

    expect(() =>
      atual.renewInto({
        contractNumber: 'ENT-2027-0001',
        startsAt: new Date(HOJE.getTime() + 100 * DIA),
        endsAt: new Date(HOJE.getTime() + 465 * DIA),
        signedAt: HOJE,
      }),
    ).toThrow(ContractTransitionError);
  });

  it('recusa renovar um contrato que ainda não foi ativado', () => {
    const assinado = EnterpriseContract.create(props());

    // Sem organização não há cliente para renovar — o que falta é ativar.
    expect(() =>
      assinado.renewInto({ ...PROXIMO_TERMO, contractNumber: 'X' }),
    ).toThrow(ContractTransitionError);
  });

  it('recusa renovar um contrato cancelado', () => {
    const cancelado = ativo();
    cancelado.cancel();

    expect(() =>
      cancelado.renewInto({ ...PROXIMO_TERMO, contractNumber: 'X' }),
    ).toThrow(ContractTransitionError);
  });

  it('um contrato vencido ainda pode ser renovado', () => {
    const vencido = ativo();
    vencido.markExpired(new Date(HOJE.getTime() + 400 * DIA));

    // É o caso comum de renovação atrasada: o cliente ficou sem acesso por
    // alguns dias e o comercial fechou depois. Recusar aqui obrigaria a criar
    // um contrato solto, quebrando a cadeia justamente onde ela explica o
    // intervalo.
    expect(() =>
      vencido.renewInto({ ...PROXIMO_TERMO, contractNumber: 'X' }),
    ).not.toThrow();
  });
});

/**
 * A correção do contrato **antes** da ativação.
 *
 * O aditivo cobre o que muda depois que o cliente já está usando o que foi
 * provisionado. Antes disso não há nada provisionado, e um valor digitado
 * errado é erro de digitação, não renegociação — registrar um aditivo para
 * consertar dígito encheria o histórico do cliente de documentos que não
 * descrevem acordo nenhum.
 *
 * Sem este caminho, um contrato assinado com o valor errado só saía cancelando
 * e recriando: queimava um número de contrato e deixava um `CANCELED` no
 * histórico de quem nunca desistiu de nada.
 */
describe('corrigir antes de ativar', () => {
  it('reescreve os termos do contrato assinado', () => {
    const c = EnterpriseContract.create(props());

    c.correct({
      billingAmount: 60000,
      endsAt: new Date(HOJE.getTime() + 730 * DIA),
    });

    expect(c.billingAmount).toBe(60000);
    expect(c.endsAt).toEqual(new Date(HOJE.getTime() + 730 * DIA));
  });

  it('o que não foi passado fica como estava', () => {
    const c = EnterpriseContract.create(props());
    const antes = c.paymentTerms;

    c.correct({ billingAmount: 60000 });

    expect(c.paymentTerms).toBe(antes);
    expect(c.limits.maxSeats).toBe(150);
  });

  it('corrige os tetos negociados', () => {
    const c = EnterpriseContract.create(props());

    c.correct({
      limits: {
        maxSeats: 200,
        maxAdAccounts: 40,
        maxMonitoredAds: null,
        maxOrganizations: null,
        llmDailyBudgetBase: null,
      },
    });

    expect(c.limits.maxSeats).toBe(200);
  });

  it('recusa depois de ativado — aí é aditivo', () => {
    const c = ativo();

    /**
     * Depois da ativação o cliente já opera dentro do que foi provisionado, e
     * mudar em silêncio apagaria o que ele contratou. Dois caminhos para a
     * mesma mudança fariam metade das alterações não deixar rastro.
     */
    expect(() => c.correct({ billingAmount: 60000 })).toThrow(
      ContractTransitionError,
    );
  });

  it('recusa num contrato esperando a primeira baixa', () => {
    const c = EnterpriseContract.create(props({ activateOnSignature: false }));
    c.activate(HOJE);
    c.linkOrganization('org-1');

    // `PENDING_ACTIVATION` já provisionou a organização: o acesso é que espera
    // o pagamento. Corrigir aqui mexeria numa cota que já foi escrita.
    expect(() => c.correct({ billingAmount: 60000 })).toThrow(
      ContractTransitionError,
    );
  });

  it('recusa um contrato cancelado', () => {
    const c = EnterpriseContract.create(props());
    c.cancel();

    expect(() => c.correct({ billingAmount: 60000 })).toThrow(
      ContractTransitionError,
    );
  });

  it('as mesmas validações da criação continuam valendo', () => {
    const c = EnterpriseContract.create(props());

    // Corrigir não pode produzir um contrato que a criação teria recusado.
    expect(() => c.correct({ billingAmount: 0 })).toThrow(
      ContractTransitionError,
    );
    expect(() =>
      c.correct({ endsAt: new Date(HOJE.getTime() - 400 * DIA) }),
    ).toThrow(ContractTransitionError);
    expect(() => c.correct({ gracePeriodDays: -1 })).toThrow(
      ContractTransitionError,
    );
  });
});

/**
 * Duas vigências não podem se sobrepor na mesma organização.
 *
 * A renovação já se protege disso ao gerar o sucessor, mas criar um contrato
 * avulso e ativá-lo não passava por guarda nenhuma. O resultado eram dois
 * contratos vigentes ao mesmo tempo: a cota sobrescrita pelo último a ativar, e
 * a cobrança emitindo fatura pelos dois — sem que nada tivesse falhado.
 */
describe('sobreposição de vigência', () => {
  const contrato = (deDias: number, ateDias: number) =>
    EnterpriseContract.create(
      props({
        startsAt: new Date(HOJE.getTime() + deDias * DIA),
        endsAt: new Date(HOJE.getTime() + ateDias * DIA),
      }),
    );

  it('vigências que se cruzam se sobrepõem', () => {
    expect(contrato(-30, 335).overlaps(contrato(100, 465))).toBe(true);
  });

  it('uma dentro da outra também', () => {
    expect(contrato(-30, 335).overlaps(contrato(10, 20))).toBe(true);
  });

  it('a mesma vigência, obviamente', () => {
    expect(contrato(-30, 335).overlaps(contrato(-30, 335))).toBe(true);
  });

  it('a renovação encostada no fim não se sobrepõe', () => {
    const atual = contrato(-365, 0);
    const seguinte = contrato(0, 365);

    /**
     * O caso que a guarda **não** pode recusar: o sucessor começa quando o
     * anterior termina, e `renewInto` produz exatamente essa borda. Tratá-la
     * como sobreposição impediria toda renovação.
     */
    expect(atual.overlaps(seguinte)).toBe(false);
  });

  it('contratos em janelas distantes não se sobrepõem', () => {
    expect(contrato(-365, -1).overlaps(contrato(30, 395))).toBe(false);
  });

  it('a ordem da comparação não importa', () => {
    const a = contrato(-30, 335);
    const b = contrato(100, 465);

    expect(a.overlaps(b)).toBe(b.overlaps(a));
  });
});

describe('EnterpriseContract — documento assinado', () => {
  const PDF = 'https://bucket/contracts/c-1/contrato.pdf';
  const OUTRO = 'https://bucket/contracts/c-1/contrato-corrigido.pdf';

  it('anexa num contrato ainda não ativado', () => {
    const contract = EnterpriseContract.create(props());

    contract.attachSignedDocument(PDF);

    expect(contract.signedDocumentUrl).toBe(PDF);
  });

  it('antes da ativação, trocar é corrigir', () => {
    const contract = EnterpriseContract.create(
      props({ signedDocumentUrl: PDF }),
    );

    contract.attachSignedDocument(OUTRO);

    expect(contract.signedDocumentUrl).toBe(OUTRO);
  });

  it('anexa num contrato ativo que ainda não tinha documento', () => {
    const contract = ativo();

    contract.attachSignedDocument(PDF);

    expect(contract.signedDocumentUrl).toBe(PDF);
  });

  it('anexa num contrato cancelado — o histórico ainda precisa da prova', () => {
    const contract = ativo();
    contract.cancel();

    contract.attachSignedDocument(PDF);

    expect(contract.signedDocumentUrl).toBe(PDF);
  });

  it('recusa trocar o documento de um contrato ativado', () => {
    const contract = ativo({ signedDocumentUrl: PDF });

    expect(() => contract.attachSignedDocument(OUTRO)).toThrow(
      ContractTransitionError,
    );
    expect(contract.signedDocumentUrl).toBe(PDF);
  });
});
