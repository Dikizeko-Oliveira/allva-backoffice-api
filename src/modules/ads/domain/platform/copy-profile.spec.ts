import {
  checkCopyLength,
  copyFieldProfile,
  copyFieldWritability,
  writableCopyFields,
} from './platform-profiles';

/**
 * P6 — **a diferença entre plataformas é contrato, não condicional**.
 *
 * O que estas asserções protegem é a distinção que a geração de copy depende
 * para não mentir: *gerado* e *aplicável* são coisas diferentes, e o perfil é o
 * único lugar onde a diferença mora.
 */

describe('perfil de copy — o que cada plataforma sabe escrever', () => {
  it('declara os campos que cada plataforma escreve', () => {
    expect(writableCopyFields('META')).toEqual(['primaryText', 'callToAction']);
    // Google: título e descrição sobre um asset escolhido, e a chamada para
    // ação — cada um no formato de anúncio em que o campo existe.
    expect(writableCopyFields('GOOGLE')).toEqual([
      'headline',
      'description',
      'callToAction',
    ]);
    // TikTok: o campo de texto único e o CTA, recriando o anúncio.
    expect(writableCopyFields('TIKTOK')).toEqual([
      'primaryText',
      'callToAction',
    ]);
  });

  it('título e descrição da Meta não são aplicáveis — e o motivo é declarado', () => {
    const headline = copyFieldProfile('META', 'headline');

    expect(headline.writableBy).toBeNull();
    // Sem o motivo, a tela inventaria "indisponível" — que não explica nada.
    expect(headline.unavailableReason).toContain('texto principal');
  });

  it('a ação que escreve cada campo é declarada, não deduzida', () => {
    expect(copyFieldProfile('META', 'primaryText').writableBy).toBe(
      'REPLACE_COPY',
    );
    expect(copyFieldProfile('META', 'callToAction').writableBy).toBe(
      'REPLACE_CTA',
    );
  });
});

/**
 * O recorte que faltava: no Google, "a plataforma escreve este campo" e "este
 * anúncio tem este campo" são perguntas diferentes. Enquanto só havia a
 * primeira, o perfil tinha de escolher entre prometer CTA na busca — onde ele
 * não existe — e negá-lo no display, onde existe.
 */
describe('perfil de copy — o campo existe neste anúncio?', () => {
  it('no Google, CTA é do display e do Demand Gen', () => {
    expect(
      copyFieldWritability('GOOGLE', 'callToAction', 'RESPONSIVE_DISPLAY_AD'),
    ).toEqual({ writable: true, writableBy: 'REPLACE_CTA' });

    const busca = copyFieldWritability(
      'GOOGLE',
      'callToAction',
      'RESPONSIVE_SEARCH_AD',
    );

    expect(busca.writable).toBe(false);
    if (!busca.writable) {
      expect(busca.reason).toContain('RESPONSIVE_SEARCH_AD');
    }
  });

  it('no Google, título é do anúncio de busca', () => {
    expect(
      copyFieldWritability('GOOGLE', 'headline', 'RESPONSIVE_SEARCH_AD')
        .writable,
    ).toBe(true);
    expect(
      copyFieldWritability('GOOGLE', 'headline', 'RESPONSIVE_DISPLAY_AD')
        .writable,
    ).toBe(false);
  });

  /** Sem formato lido, prometer a escrita seria adivinhar. */
  it('recusa quando o formato ainda não foi sincronizado', () => {
    const result = copyFieldWritability('GOOGLE', 'callToAction', null);

    expect(result.writable).toBe(false);
    if (!result.writable) expect(result.reason).toContain('ainda não foi lido');
  });

  /** Onde a plataforma não recorta, o formato não muda a resposta. */
  it('na Meta o CTA vale em qualquer formato, mesmo desconhecido', () => {
    expect(copyFieldWritability('META', 'callToAction', null)).toEqual({
      writable: true,
      writableBy: 'REPLACE_CTA',
    });
  });

  it('campo que a plataforma não escreve continua recusado pelo motivo do perfil', () => {
    const result = copyFieldWritability('META', 'headline', 'IMAGE');

    expect(result.writable).toBe(false);
    if (!result.writable) expect(result.reason).toContain('texto principal');
  });
});

describe('perfil de copy — limite duro contra limite de exibição', () => {
  it('a Meta trunca o texto principal; não recusa', () => {
    const profile = copyFieldProfile('META', 'primaryText');

    expect(profile.maxLength).toBeNull();
    expect(profile.recommendedLength).toBe(125);
    expect(checkCopyLength('META', 'primaryText', 'a'.repeat(400))).toEqual({
      fits: true,
    });
  });

  it('o Google recusa título acima de 30 — e o motivo carrega os dois números', () => {
    const result = checkCopyLength('GOOGLE', 'headline', 'a'.repeat(31));

    expect(result.fits).toBe(false);
    if (!result.fits) {
      expect(result.reason).toContain('31 caracteres');
      expect(result.reason).toContain('30');
    }
  });

  it('o TikTok é a única com piso, e ele é recusa como o teto', () => {
    expect(checkCopyLength('TIKTOK', 'primaryText', 'curto').fits).toBe(false);
    expect(checkCopyLength('TIKTOK', 'primaryText', 'a'.repeat(50)).fits).toBe(
      true,
    );
    expect(checkCopyLength('TIKTOK', 'primaryText', 'a'.repeat(101)).fits).toBe(
      false,
    );
  });
});

describe('perfil de copy — CTA é enum, nunca prosa', () => {
  it('a Meta recusa uma frase no lugar do valor de enum', () => {
    const result = checkCopyLength(
      'META',
      'callToAction',
      'Peça sua demonstração',
    );

    expect(result.fits).toBe(false);
    // O motivo lista o que é aceito: recusar sem dizer o que serve deixa quem
    // recebeu sem próximo passo.
    if (!result.fits) expect(result.reason).toContain('LEARN_MORE');
  });

  it('um valor da lista passa', () => {
    expect(checkCopyLength('META', 'callToAction', 'SHOP_NOW')).toEqual({
      fits: true,
    });
  });
});
