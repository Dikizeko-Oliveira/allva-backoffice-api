import {
  buildObjectKey,
  decodeObjectKey,
  encodeObjectKey,
} from './storage-object-key';

describe('buildObjectKey', () => {
  it('põe o objeto na pasta pedida e preserva a extensão', () => {
    const key = buildObjectKey('Banner Final.PNG', 'creatives');

    expect(key).toMatch(/^creatives\/banner-final-[0-9a-f]{8}\.PNG$/);
  });

  it('prefere o nome da campanha ao do arquivo quando ele vem', () => {
    const key = buildObjectKey(
      'IMG_0042.jpg',
      'creatives',
      'Black Friday 2026',
    );

    expect(key).toMatch(/^creatives\/black-friday-2026-[0-9a-f]{8}\.jpg$/);
  });

  it('não deixa acento, espaço ou pontuação virarem parte da chave', () => {
    // Chave é caminho em URL: o que não for slug volta como escape ilegível na
    // primeira vez que alguém copiar o link de um relatório.
    const key = buildObjectKey('Relatório — Maio/2026 (v2).pdf', 'reports');

    expect(key).toMatch(/^reports\/relat-rio-maio-2026-v2-[0-9a-f]{8}\.pdf$/);
  });

  /**
   * A razão de o sufixo existir. Sem ele, o segundo upload do mesmo nome
   * sobrescreve o primeiro em silêncio — e o registro que apontava para o
   * objeto antigo passa a devolver conteúdo de outra pessoa.
   */
  it('nunca gera a mesma chave duas vezes para a mesma entrada', () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => buildObjectKey('a.png', 'creatives')),
    );

    expect(keys.size).toBe(50);
  });
});

describe('encodeObjectKey', () => {
  it('escapa cada segmento sem transformar as barras em %2F', () => {
    expect(encodeObjectKey('reports/uma coisa.pdf')).toBe(
      'reports/uma%20coisa.pdf',
    );
  });

  it('volta ao original ao ser decodificado', () => {
    const key = 'creatives/ação de maio/arte final.png';

    expect(decodeObjectKey(encodeObjectKey(key))).toBe(key);
  });
});
