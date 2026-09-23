import { buildGcsObjectUrl, extractGcsObjectKey } from './gcs-object-url';

const BUCKET = 'allva-media';

describe('buildGcsObjectUrl', () => {
  it('monta a URL pública no formato de caminho', () => {
    expect(
      buildGcsObjectUrl('creatives/arte-ab12.png', { bucket: BUCKET }),
    ).toBe(
      'https://storage.googleapis.com/allva-media/creatives/arte-ab12.png',
    );
  });

  it('usa o domínio próprio quando ele existe, sem duplicar a barra', () => {
    expect(
      buildGcsObjectUrl('creatives/arte-ab12.png', {
        bucket: BUCKET,
        publicBaseUrl: 'https://cdn.allva.app/',
      }),
    ).toBe('https://cdn.allva.app/creatives/arte-ab12.png');
  });

  it('ignora um domínio próprio em branco em vez de montar "  /chave"', () => {
    expect(
      buildGcsObjectUrl('reports/x-ab12.pdf', {
        bucket: BUCKET,
        publicBaseUrl: '   ',
      }),
    ).toBe('https://storage.googleapis.com/allva-media/reports/x-ab12.pdf');
  });
});

describe('extractGcsObjectKey', () => {
  const KEY = 'creatives/arte-ab12.png';

  it('lê de volta o que ele mesmo montou', () => {
    const context = { bucket: BUCKET };

    expect(extractGcsObjectKey(buildGcsObjectUrl(KEY, context), context)).toBe(
      KEY,
    );
  });

  it('lê de volta o que montou atrás de um domínio próprio', () => {
    const context = { bucket: BUCKET, publicBaseUrl: 'https://cdn.allva.app' };

    expect(extractGcsObjectKey(buildGcsObjectUrl(KEY, context), context)).toBe(
      KEY,
    );
  });

  it('aceita a forma virtual-hosted, que o SDK também emite', () => {
    expect(
      extractGcsObjectKey(`https://${BUCKET}.storage.googleapis.com/${KEY}`, {
        bucket: BUCKET,
      }),
    ).toBe(KEY);
  });

  /**
   * Uma URL gravada antes de o CDN existir continua no banco. Se a extração só
   * soubesse ler a forma corrente, o delete apagaria a chave errada — ou
   * nenhuma — em todo objeto anterior à mudança de configuração.
   */
  it('ainda lê a forma antiga depois de o domínio próprio ser configurado', () => {
    expect(
      extractGcsObjectKey(`https://storage.googleapis.com/${BUCKET}/${KEY}`, {
        bucket: BUCKET,
        publicBaseUrl: 'https://cdn.allva.app',
      }),
    ).toBe(KEY);
  });

  it('desconta o caminho do domínio próprio quando ele tem um', () => {
    expect(
      extractGcsObjectKey(`https://cdn.allva.app/media/${KEY}`, {
        bucket: BUCKET,
        publicBaseUrl: 'https://cdn.allva.app/media',
      }),
    ).toBe(KEY);
  });

  it('desfaz o escape dos segmentos', () => {
    expect(
      extractGcsObjectKey(
        'https://storage.googleapis.com/allva-media/reports/uma%20coisa.pdf',
        { bucket: BUCKET },
      ),
    ).toBe('reports/uma coisa.pdf');
  });

  /**
   * O motivo de a remoção do prefixo comparar segmentos inteiros. Com um
   * `startsWith` cru, uma chave que começa com o nome do bucket perderia a
   * cabeça e o delete acertaria outro objeto.
   */
  it('não decapita uma chave que apenas começa com o nome do bucket', () => {
    expect(
      extractGcsObjectKey(
        `https://storage.googleapis.com/${BUCKET}/${BUCKET}-backup/arte.png`,
        { bucket: BUCKET },
      ),
    ).toBe(`${BUCKET}-backup/arte.png`);
  });
});
