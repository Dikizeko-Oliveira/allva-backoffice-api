import {
  decideResolution,
  isRestatement,
  supersededByDetector,
} from './resolution';

/**
 * §10.7 passo 7 — **ausência de dado nunca é evidência.**
 *
 * Sem esta regra, uma integração fora do ar por uma noite resolve todo o
 * desperdício aberto da organização como "condição cessou", e na manhã seguinte
 * o produto reporta um dia excepcionalmente bom — produzido inteiramente pela
 * própria cegueira.
 */
describe('auto-resolve (§10.7 passo 7)', () => {
  it('sem observação válida, NADA é resolvido — o item fica aberto e velho', () => {
    const decision = decideResolution({
      observation: { valid: false, adArchived: false },
      // Mesmo com o achado tendo sumido do ciclo e com sinal de re-declaração:
      // sem observação válida, nenhum dos dois é sequer consultado.
      restated: true,
    });

    expect(decision).toEqual({ action: 'KEEP', staleObservation: true });
  });

  it('a guarda vale inclusive para o anúncio arquivado', () => {
    // Arquivado numa leitura que não cobriu a conta não é arquivado: é "não
    // vimos". Resolver como `STALE` aqui fecharia achados reais com base numa
    // varredura incompleta.
    const decision = decideResolution({
      observation: { valid: false, adArchived: true },
      restated: false,
    });

    expect(decision.action).toBe('KEEP');
  });

  it('anúncio arquivado com observação válida resolve como STALE', () => {
    expect(
      decideResolution({
        observation: { valid: true, adArchived: true },
        restated: false,
      }),
    ).toMatchObject({ action: 'RESOLVE', kind: 'STALE' });
  });

  it('condição cessou de verdade resolve como RESOLVED_EXTERNALLY', () => {
    expect(
      decideResolution({
        observation: { valid: true, adArchived: false },
        restated: false,
      }),
    ).toMatchObject({ action: 'RESOLVE', kind: 'RESOLVED_EXTERNALLY' });
  });

  it('re-declaração resolve como RESOLVED_BY_RESTATEMENT, não como acerto', () => {
    // A separação preserva a honestidade do dataset de P8: um item que some
    // porque o dado foi reescrito é **falso positivo**, e contá-lo como acerto
    // inflaria a taxa do detector exatamente com os casos em que ele errou.
    expect(
      decideResolution({
        observation: { valid: true, adArchived: false },
        restated: true,
      }),
    ).toMatchObject({ action: 'RESOLVE', kind: 'RESOLVED_BY_RESTATEMENT' });
  });
});

describe('o discriminador de re-declaração', () => {
  it('gasto parado com conversão subindo é re-declaração', () => {
    expect(
      isRestatement({
        previousObserved: { spendBase: 1_000, conversions: 0, revenueBase: 0 },
        currentObserved: { spendBase: 1_000, conversions: 4, revenueBase: 900 },
      }),
    ).toBe(true);
  });

  it('gasto subindo com conversão subindo é o anúncio funcionando', () => {
    // O anúncio continuou rodando e passou a converter. Isso é
    // `RESOLVED_EXTERNALLY` de verdade — o detector acertou e a condição cessou.
    expect(
      isRestatement({
        previousObserved: { spendBase: 1_000, conversions: 0, revenueBase: 0 },
        currentObserved: { spendBase: 1_600, conversions: 4, revenueBase: 900 },
      }),
    ).toBe(false);
  });

  it('tolera a correção de centavos que acompanha a re-declaração', () => {
    // Re-declaração também mexe em gasto (tráfego inválido estornado, ajuste de
    // leilão). Exigir gasto idêntico classificaria como mudança real toda
    // re-declaração que veio com um centavo de correção junto.
    expect(
      isRestatement({
        previousObserved: { spendBase: 1_000, conversions: 0, revenueBase: 0 },
        currentObserved: { spendBase: 1_010, conversions: 3, revenueBase: 0 },
      }),
    ).toBe(true);
  });

  it('sem os valores anteriores, o desfecho conservador é NÃO ser re-declaração', () => {
    // Na dúvida, creditar o acerto ao mundo. O inverso inflaria a contagem de
    // falsos positivos com casos que ninguém verificou.
    expect(
      isRestatement({
        previousObserved: null,
        currentObserved: { spendBase: 1_000, conversions: 4, revenueBase: 900 },
      }),
    ).toBe(false);
  });
});

/**
 * §10.4 — **só mudança de lógica supersede.**
 *
 * Se a troca de perfil supersedesse, calibrar um limiar fecharia e reabriria a
 * base inteira: `occurrences` voltaria a 1 em cada item, e a recorrência — sinal
 * de P8 — seria zerada por um ajuste de configuração.
 */
describe('supersessão por versão (§10.4)', () => {
  it('mudança de versão do detector supersede', () => {
    expect(
      supersededByDetector({
        itemDetectorVersion: 'v1.9.0',
        currentDetectorVersion: 'v2.0.0',
      }),
    ).toBe(true);
  });

  it('mesma versão do detector não supersede, qualquer que seja o limiar', () => {
    expect(
      supersededByDetector({
        itemDetectorVersion: 'v2.0.0',
        currentDetectorVersion: 'v2.0.0',
      }),
    ).toBe(false);
  });
});
