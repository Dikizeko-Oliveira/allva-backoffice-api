import {
  MAX_BATCH_SIZE,
  PLATFORM_VALIDATION_THRESHOLD,
  checkBatch,
  summarize,
} from './batch';

const pause = (adId: string) => ({ adId, type: 'PAUSE_AD' as const });

function check(
  items: Array<{ adId: string; type: 'PAUSE_AD' | 'REPLACE_COPY' }>,
  validationDepth?: 'LOCAL_ONLY' | 'PLATFORM',
) {
  return checkBatch({ items, validationDepth });
}

describe('§13.5 — guardas do lote', () => {
  it('aceita um lote pequeno e bem formado', () => {
    expect(check([pause('a'), pause('b')])).toBeNull();
  });

  it('recusa lote vazio', () => {
    expect(check([])?.code).toBe('BATCH_EMPTY');
  });

  /** O teto de blast radius: cem é o limite declarado. */
  it('recusa acima de cem itens, dizendo quantos vieram', () => {
    const refusal = check(
      Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => pause(`ad-${i}`)),
      'PLATFORM',
    );

    expect(refusal?.code).toBe('BATCH_TOO_LARGE');
    expect(refusal?.details).toMatchObject({ limit: 100, received: 101 });
  });

  it('aceita exatamente cem', () => {
    expect(
      check(
        Array.from({ length: MAX_BATCH_SIZE }, (_, i) => pause(`ad-${i}`)),
        'PLATFORM',
      ),
    ).toBeNull();
  });

  /**
   * R14 — **conteúdo autoral nunca em lote.** Confirmar cem textos num clique é
   * não confirmar nenhum, e o texto vai ao ar sob a marca do cliente. A guarda
   * existe desde A2-S7 no caminho individual; o lote é o caminho que a exercita.
   */
  it('recusa qualquer conteúdo autoral, mesmo num lote de um', () => {
    const refusal = check([{ adId: 'a', type: 'REPLACE_COPY' }]);

    expect(refusal?.code).toBe('AI_CONTENT_NOT_ALLOWED_IN_BATCH');
    expect(refusal?.details).toMatchObject({ types: ['REPLACE_COPY'] });
  });

  it('recusa o lote inteiro se um único item carrega texto', () => {
    expect(
      check([pause('a'), { adId: 'b', type: 'REPLACE_COPY' }, pause('c')])
        ?.code,
    ).toBe('AI_CONTENT_NOT_ALLOWED_IN_BATCH');
  });

  describe('profundidade de validação', () => {
    const many = Array.from(
      { length: PLATFORM_VALIDATION_THRESHOLD + 1 },
      (_, i) => pause(`ad-${i}`),
    );

    /**
     * A validação local pega parâmetro faltante e moeda errada. Só a da
     * plataforma pega "este conjunto está sob CBO" — e um dry-run local que
     * aprova onze anúncios aprova exatamente o que a plataforma vai recusar.
     */
    it('exige validação de plataforma acima de dez itens', () => {
      const refusal = check(many, 'LOCAL_ONLY');

      expect(refusal?.code).toBe('PLATFORM_VALIDATION_REQUIRED');
      expect(refusal?.details).toMatchObject({ threshold: 10, received: 11 });
    });

    it('aceita acima de dez quando a validação é de plataforma', () => {
      expect(check(many, 'PLATFORM')).toBeNull();
    });

    /** Abaixo do limiar o usuário confere item a item; acima, ele confia. */
    it('não exige nada de um lote de dez', () => {
      expect(
        check(
          Array.from({ length: PLATFORM_VALIDATION_THRESHOLD }, (_, i) =>
            pause(`ad-${i}`),
          ),
        ),
      ).toBeNull();
    });
  });

  /**
   * I2 impediria a segunda escrita de qualquer forma — o índice parcial recusa
   * duas execuções em voo no mesmo alvo —, mas ela chegaria como conflito no
   * meio do processamento, depois de a primeira já ter sido enviada. Recusar
   * aqui diz o que está errado com o pedido em vez de reportar uma corrida que
   * o próprio usuário criou.
   */
  it('recusa o mesmo anúncio repetido com a mesma ação', () => {
    const refusal = check([pause('a'), pause('b'), pause('a')]);

    expect(refusal?.code).toBe('BATCH_DUPLICATE_ITEM');
    expect(refusal?.details).toMatchObject({ adId: 'a', type: 'PAUSE_AD' });
  });

  it('deixa passar o mesmo anúncio com ações diferentes', () => {
    expect(
      check([
        { adId: 'a', type: 'PAUSE_AD' },
        { adId: 'a', type: 'REPLACE_COPY' },
      ])?.code,
    ).toBe('AI_CONTENT_NOT_ALLOWED_IN_BATCH');
  });
});

describe('relatório por item', () => {
  /**
   * §13.5 — **a recusa de um não aborta o lote.** O usuário pediu doze pausas;
   * se duas forem recusadas, as outras dez acontecem. Abortar devolveria a ele o
   * trabalho de descobrir quais passariam — que é o trabalho que o lote existe
   * para tirar dele.
   */
  it('conta aceitos e recusados sem perder nenhum item', () => {
    const report = summarize(
      [
        { adId: 'a', type: 'PAUSE_AD', status: 'ACCEPTED', executionId: 'e1' },
        {
          adId: 'b',
          type: 'PAUSE_AD',
          status: 'REFUSED',
          code: 'TARGET_ALREADY_IN_STATE',
          message: 'já pausado',
        },
        { adId: 'c', type: 'PAUSE_AD', status: 'ACCEPTED', executionId: 'e2' },
      ],
      'batch-1',
    );

    expect(report).toMatchObject({
      batchId: 'batch-1',
      total: 3,
      accepted: 2,
      refused: 1,
    });
    expect(report.items).toHaveLength(3);
  });

  it('preserva o motivo de cada recusa', () => {
    const report = summarize(
      [
        {
          adId: 'b',
          type: 'PAUSE_AD',
          status: 'REFUSED',
          code: 'WRITE_IN_FLIGHT',
          message: 'escrita em andamento',
        },
      ],
      'batch-2',
    );

    expect(report.items[0]).toMatchObject({
      status: 'REFUSED',
      code: 'WRITE_IN_FLIGHT',
    });
  });
});
