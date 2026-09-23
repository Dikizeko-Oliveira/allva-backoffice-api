import {
  UNVERIFIED_AFTER_DAYS,
  unverifiedBefore,
} from './verification-freshness';

/**
 * O limiar que separa "achado confirmado" de "achado parado".
 *
 * Passou a importar quando o escopo da varredura começou a girar: o teto do
 * plano governa quantos anúncios entram por noite, e a cauda circula por
 * rodízio. Antes disso todo achado aberto era reconfirmado toda madrugada e
 * `lastSeenAt` era sempre de ontem.
 */
describe('unverifiedBefore', () => {
  it('corta em uma semana atrás', () => {
    expect(unverifiedBefore(new Date('2026-09-08T12:00:00.000Z'))).toEqual(
      new Date('2026-09-01T12:00:00.000Z'),
    );
  });

  it('atravessa a virada do mês sem inventar dia', () => {
    // `setUTCDate` com valor negativo volta para o mês anterior sozinho — o
    // teste existe para que ninguém "conserte" isso com aritmética de 30 dias.
    expect(unverifiedBefore(new Date('2026-03-03T00:00:00.000Z'))).toEqual(
      new Date('2026-02-24T00:00:00.000Z'),
    );
  });

  it('não muta a data recebida', () => {
    // O `now` costuma ser compartilhado com outras leituras da mesma requisição.
    // Mutá-lo faria o resto do agregado ler uma semana no passado sem aviso.
    const now = new Date('2026-09-08T12:00:00.000Z');

    unverifiedBefore(now);

    expect(now).toEqual(new Date('2026-09-08T12:00:00.000Z'));
  });

  it('o limiar é declarado, não espalhado', () => {
    // A tela escreve "há mais de uma semana"; se a constante mudar sem a frase
    // mudar junto, o produto passa a dizer um número que não é o dele.
    expect(UNVERIFIED_AFTER_DAYS).toBe(7);
  });
});
