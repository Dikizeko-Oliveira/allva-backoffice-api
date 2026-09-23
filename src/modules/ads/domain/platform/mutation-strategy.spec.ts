import {
  actionImpactFor,
  mutationFor,
  requiresRecreate,
} from './platform-profiles';

/**
 * A separação que A2-S8 introduziu: **como** a plataforma aplica a mudança
 * (`MutationStrategy`) e **o que** a mudança faz com a entrega (`ActionImpact`)
 * são perguntas independentes.
 *
 * Antes havia um booleano só, `requiresRecreate`, respondendo as duas — e
 * respondendo errado nas duas pontas: dizia que a Meta cria anúncio novo ao
 * trocar o criativo (não cria) e escondia que uma edição em lugar reinicia o
 * aprendizado do mesmo jeito.
 */
describe('estratégia de mutação por plataforma (§13.1)', () => {
  it('edita em lugar o criativo na Meta, e recria no Google', () => {
    expect(mutationFor('META', 'REPLACE_CREATIVE').strategy).toBe('PATCH');
    expect(mutationFor('GOOGLE', 'REPLACE_CREATIVE').strategy).toBe('RECREATE');
  });

  /**
   * O inverso do criativo: texto é campo do anúncio no Google e vive no criativo
   * na Meta. Uma lista global de "ações que recriam" não tem como acertar as
   * duas — é literalmente a mesma ação com respostas opostas.
   */
  it('recria a copy na Meta, e edita em lugar no Google', () => {
    expect(mutationFor('META', 'REPLACE_COPY').strategy).toBe('RECREATE');
    expect(mutationFor('GOOGLE', 'REPLACE_COPY').strategy).toBe('PATCH');
  });

  it('trata duplicação como duplicação, nunca como recriação', () => {
    for (const platform of ['META', 'GOOGLE', 'TIKTOK'] as const) {
      expect(mutationFor(platform, 'DUPLICATE_AD').strategy).toBe('DUPLICATE');
      expect(requiresRecreate(platform, 'DUPLICATE_AD')).toBe(false);
    }
  });

  it('assume edição em lugar sem impacto para o que não declara nada', () => {
    expect(mutationFor('META', 'PAUSE_AD').strategy).toBe('PATCH');
    expect(actionImpactFor('META', 'PAUSE_AD')).toEqual({
      resetsLearning: false,
      losesSocialProof: false,
      changesResourceId: false,
    });
  });
});

describe('impacto separado da estratégia', () => {
  /**
   * O caso que motivou a separação inteira: na Meta, trocar o criativo mantém o
   * `ad_id` **e** reinicia o aprendizado e zera a prova social. Com um booleano
   * só, uma das duas verdades tinha de ser sacrificada.
   */
  it('declara impacto em edição que não recria', () => {
    expect(requiresRecreate('META', 'REPLACE_CREATIVE')).toBe(false);
    expect(actionImpactFor('META', 'REPLACE_CREATIVE')).toEqual({
      resetsLearning: true,
      losesSocialProof: true,
      changesResourceId: false,
    });
  });

  it('deriva changesResourceId da estratégia, e só dela', () => {
    expect(actionImpactFor('META', 'REPLACE_COPY').changesResourceId).toBe(
      true,
    );
    expect(actionImpactFor('GOOGLE', 'REPLACE_COPY').changesResourceId).toBe(
      false,
    );
  });

  /**
   * Anúncio de busca não tem post, curtida nem comentário. Declarar perda de
   * prova social ali seria avisar sobre algo que não existe — e um aviso que o
   * usuário aprende a ignorar deixa de proteger quando importa.
   */
  it('não promete perda de prova social onde não há prova social', () => {
    expect(actionImpactFor('GOOGLE', 'REPLACE_CREATIVE')).toMatchObject({
      resetsLearning: true,
      losesSocialProof: false,
    });
  });

  it('duplicar não reinicia o aprendizado de ninguém', () => {
    expect(actionImpactFor('META', 'DUPLICATE_AD')).toEqual({
      resetsLearning: false,
      losesSocialProof: false,
      changesResourceId: false,
    });
  });
});
