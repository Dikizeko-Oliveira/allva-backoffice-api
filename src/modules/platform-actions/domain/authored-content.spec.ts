import {
  authorshipOf,
  checkAuthoredContent,
  carriesAuthoredContent,
} from './authored-content';
import { contentDigest } from './idempotency';

const TEXTO = 'Aproveite 30% de desconto hoje';

function check(
  overrides: Partial<Parameters<typeof checkAuthoredContent>[0]> = {},
) {
  return checkAuthoredContent({
    actionType: 'REPLACE_COPY',
    aiAuthored: true,
    content: TEXTO,
    confirmedContentDigest: contentDigest(TEXTO),
    batchSize: 1,
    digestOf: contentDigest,
    ...overrides,
  });
}

describe('R14 — conteúdo autoral', () => {
  it('só incide sobre as ações que publicam texto', () => {
    expect(carriesAuthoredContent('REPLACE_COPY')).toBe(true);
    expect(carriesAuthoredContent('REPLACE_CTA')).toBe(true);
    expect(carriesAuthoredContent('PAUSE_AD')).toBe(false);
  });

  it('não interfere em ações sem texto', () => {
    expect(
      check({
        actionType: 'PAUSE_AD',
        aiAuthored: undefined,
        content: undefined,
      }),
    ).toBeNull();
  });

  it('aprova quando o texto confirmado é o que vai ao ar', () => {
    expect(check()).toBeNull();
  });

  /**
   * No Google o texto vai em `assetReplacement.value`. Sem esta leitura, um
   * título de IA iria ao ar sem passar pela confirmação — a guarda veria
   * "conteúdo ausente" e o texto seguiria por outro campo.
   */
  it('lê o texto do asset escolhido no Google', () => {
    expect(
      authorshipOf({
        aiAuthored: true,
        assetReplacement: {
          field: 'HEADLINE',
          index: 0,
          currentValue: 'Antes',
          value: TEXTO,
        },
      }),
    ).toEqual({ aiAuthored: true, content: TEXTO });
  });

  /**
   * **Confirmar cem textos num clique é não confirmar nenhum.** O lote entra em
   * A2-S8; a guarda nasce antes dele porque a ordem inversa seria ligar o lote e
   * proteger depois.
   */
  it('recusa qualquer conteúdo autoral em lote', () => {
    expect(check({ batchSize: 2 })?.code).toBe(
      'AI_CONTENT_NOT_ALLOWED_IN_BATCH',
    );
  });

  it('exige que a autoria seja declarada, não herdada de um default', () => {
    expect(check({ aiAuthored: undefined })?.code).toBe(
      'AI_AUTHORSHIP_NOT_DECLARED',
    );
  });

  /**
   * Texto humano não precisa de confirmação separada: quem o escreveu já o leu.
   * A exigência existe porque ninguém lê o que não escreveu.
   */
  it('não exige confirmação de texto escrito por gente', () => {
    expect(
      check({ aiAuthored: false, confirmedContentDigest: undefined }),
    ).toBeNull();
  });

  it('recusa texto de IA sem confirmação', () => {
    expect(check({ confirmedContentDigest: undefined })?.code).toBe(
      'AI_CONTENT_CONFIRMATION_REQUIRED',
    );
  });

  /**
   * O caso que um booleano de confirmação não pegaria: o usuário confirma, o
   * texto é regenerado, e o que vai ao ar não é o que alguém leu. É por isso que
   * a confirmação é o **dígito do conteúdo**.
   */
  it('recusa quando o texto mudou depois da confirmação', () => {
    const failure = check({
      confirmedContentDigest: contentDigest('Outro texto qualquer'),
    });

    expect(failure?.code).toBe('AI_CONTENT_CHANGED_AFTER_CONFIRMATION');
  });

  it('ignora espaço de borda, e só isso', () => {
    expect(check({ content: `  ${TEXTO}  ` })).toBeNull();
    // Um parágrafo a mais **é** outro texto.
    expect(check({ content: `${TEXTO}\n\nGarantia total.` })?.code).toBe(
      'AI_CONTENT_CHANGED_AFTER_CONFIRMATION',
    );
  });

  it('recusa declarar IA sem trazer o texto', () => {
    expect(check({ content: undefined })?.code).toBe('AI_CONTENT_MISSING');
  });
});
