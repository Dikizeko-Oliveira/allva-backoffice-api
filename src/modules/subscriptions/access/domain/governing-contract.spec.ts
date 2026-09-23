import { selectGoverningContract } from './governing-contract';

/**
 * Qual contrato responde, quando a organização tem mais de um.
 *
 * Ela tem mais de um o tempo todo depois da primeira renovação: o vigente e o
 * seguinte, assinado com meses de antecedência. Escolher "o mais recente"
 * pareceria certo e fecharia o produto no dia em que o comercial assinasse a
 * renovação — porque o mais recente ainda não começou.
 */

const DIA = 24 * 60 * 60 * 1000;
const AGORA = new Date('2026-09-04T12:00:00Z');

const termo = (deDias: number, ateDias: number) => ({
  startsAt: new Date(AGORA.getTime() + deDias * DIA),
  endsAt: new Date(AGORA.getTime() + ateDias * DIA),
});

const VIGENTE = { id: 'vigente', ...termo(-30, 335) };
const SEGUINTE = { id: 'seguinte', ...termo(335, 700) };
const ANTERIOR = { id: 'anterior', ...termo(-400, -31) };

describe('o contrato que governa agora', () => {
  it('sem contrato nenhum: não há resposta', () => {
    expect(selectGoverningContract([], AGORA)).toBeNull();
  });

  it('um só, vigente: é ele', () => {
    expect(selectGoverningContract([VIGENTE], AGORA)?.id).toBe('vigente');
  });

  it('vigente e renovação assinada: o vigente responde', () => {
    /**
     * O caso que motiva a função. A renovação é assinada meses antes de
     * começar; se ela vencesse a escolha, o cliente cairia em
     * `PENDING_ACTIVATION` no dia da assinatura — perdendo o acesso que ainda
     * está pago justamente porque renovou cedo.
     */
    expect(selectGoverningContract([SEGUINTE, VIGENTE], AGORA)?.id).toBe(
      'vigente',
    );
  });

  it('a ordem da lista não muda a resposta', () => {
    expect(selectGoverningContract([VIGENTE, SEGUINTE], AGORA)?.id).toBe(
      'vigente',
    );
  });

  it('só o seguinte, ainda por começar: é ele', () => {
    // Contrato assinado com início no mês que vem — e a espera é a resposta
    // certa, que é o que `PENDING_ACTIVATION` diz.
    expect(selectGoverningContract([SEGUINTE], AGORA)?.id).toBe('seguinte');
  });

  it('só contratos encerrados: o último a terminar', () => {
    const maisAntigo = { id: 'antigo', ...termo(-800, -401) };

    // É ele que descreve até quando o cliente teve acesso, e é a data que a
    // renovação vencida precisa mostrar.
    expect(selectGoverningContract([maisAntigo, ANTERIOR], AGORA)?.id).toBe(
      'anterior',
    );
  });

  it('encerrado e um futuro pela frente: o futuro responde', () => {
    /**
     * O intervalo entre contratos. Os dois fecham o acesso, então a escolha não
     * muda o portão — muda o que o cliente lê. "Seu contrato começa em
     * novembro" é útil; "seu contrato venceu em agosto" esconde que já existe
     * um substituto assinado.
     */
    expect(selectGoverningContract([ANTERIOR, SEGUINTE], AGORA)?.id).toBe(
      'seguinte',
    );
  });

  it('entre dois futuros, o que começa antes', () => {
    const distante = { id: 'distante', ...termo(700, 1065) };

    expect(selectGoverningContract([distante, SEGUINTE], AGORA)?.id).toBe(
      'seguinte',
    );
  });

  it('no último instante da vigência ainda é o vigente', () => {
    const terminando = { id: 'terminando', ...termo(-365, 0) };

    // A borda é a virada de um contrato para o outro, e é justamente onde o
    // cliente não pode piscar sem acesso.
    expect(selectGoverningContract([terminando, SEGUINTE], AGORA)?.id).toBe(
      'terminando',
    );
  });
});
