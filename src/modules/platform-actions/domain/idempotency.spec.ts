import { canonicalize, requestDigest, resolveIdempotency } from './idempotency';

const base = {
  adId: 'ad-1',
  actionType: 'PAUSE_AD',
  targetEntityType: 'AD',
  targetEntityId: 'ad-1',
  parameters: {
    schemaVersion: 1,
    type: 'STATUS_CHANGE',
    desiredStatus: 'PAUSED',
  },
  dryRun: false,
};

describe('dígito do pedido (A8, ⊕2)', () => {
  it('é estável para o mesmo pedido', () => {
    expect(requestDigest(base)).toBe(requestDigest({ ...base }));
  });

  /**
   * `{a:1,b:2}` e `{b:2,a:1}` são o mesmo pedido. Sem canonicalização, todo
   * cliente que serializa em ordem instável receberia `IDEMPOTENCY_KEY_REUSED`
   * ao repetir exatamente a mesma coisa — e o retry legítimo viraria erro.
   */
  it('ignora a ordem das chaves', () => {
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(
      requestDigest({
        ...base,
        parameters: {
          desiredStatus: 'PAUSED',
          type: 'STATUS_CHANGE',
          schemaVersion: 1,
        },
      }),
    ).toBe(requestDigest(base));
  });

  /**
   * Ordem de array **é** significativa: dois criativos em ordem trocada são
   * pedidos diferentes, e normalizá-la esconderia a diferença.
   */
  it('preserva a ordem dos arrays', () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it('muda quando o parâmetro muda', () => {
    expect(
      requestDigest({
        ...base,
        parameters: { ...base.parameters, desiredStatus: 'ACTIVE' },
      }),
    ).not.toBe(requestDigest(base));
  });

  /**
   * Validar e executar são pedidos diferentes. Reaproveitar a chave do dry-run
   * para a escrita real devolveria o resultado da validação — um `202` que
   * nunca escreveu nada.
   */
  it('separa dry-run de escrita real', () => {
    expect(requestDigest({ ...base, dryRun: true })).not.toBe(
      requestDigest(base),
    );
  });

  it('distingue alvos diferentes com os mesmos parâmetros', () => {
    expect(requestDigest({ ...base, targetEntityId: 'ad-2' })).not.toBe(
      requestDigest(base),
    );
  });

  it('não confunde ausência com nulo declarado', () => {
    expect(canonicalize({ a: undefined })).toBe('{}');
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
});

describe('resolução de idempotência', () => {
  it('trata chave inédita como pedido novo', () => {
    expect(resolveIdempotency({ existing: null, digest: 'd1' })).toEqual({
      kind: 'FRESH',
    });
  });

  it('devolve o resultado original no replay legítimo', () => {
    expect(
      resolveIdempotency({
        existing: { executionId: 'exec-1', requestDigest: 'd1' },
        digest: 'd1',
      }),
    ).toEqual({ kind: 'REPLAY', executionId: 'exec-1' });
  });

  /**
   * O caso que a chave sozinha não resolve: um retry de formulário que o
   * usuário editou entre as tentativas. Devolver "o original" ali devolveria o
   * resultado de **outra** ação — e o cliente a registraria como se fosse a que
   * pediu.
   */
  it('recusa a mesma chave com pedido diferente', () => {
    expect(
      resolveIdempotency({
        existing: { executionId: 'exec-1', requestDigest: 'd1' },
        digest: 'd2',
      }),
    ).toEqual({ kind: 'REUSED_WITH_DIFFERENT_PAYLOAD' });
  });
});
