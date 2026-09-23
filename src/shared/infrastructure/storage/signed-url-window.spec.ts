import { signedUrlWindow } from './signed-url-window';

const TTL = 3600;
const HOUR = 3600_000;

describe('signedUrlWindow', () => {
  it('devolve a mesma janela para qualquer instante dentro dela', () => {
    // É a propriedade inteira: URL idêntica byte a byte enquanto a janela dura,
    // que é o que faz o cache do browser funcionar.
    const start = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);

    const first = signedUrlWindow(TTL, start);
    const middle = signedUrlWindow(TTL, start + HOUR / 2);
    const last = signedUrlWindow(TTL, start + HOUR - 1);

    expect(middle).toEqual(first);
    expect(last).toEqual(first);
  });

  it('muda de janela quando a hora vira', () => {
    const start = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);

    expect(signedUrlWindow(TTL, start + HOUR)).not.toEqual(
      signedUrlWindow(TTL, start),
    );
  });

  /**
   * O piso é o que impede um link de chegar quase vencido: quem pede no último
   * segundo da janela ainda recebe um TTL inteiro pela frente.
   */
  it('nunca entrega menos que um TTL de validade', () => {
    for (const offset of [0, 1, HOUR / 3, HOUR - 1]) {
      const now = 1_800_000_000_000 + offset;
      const { expiresAt } = signedUrlWindow(TTL, now);

      expect(expiresAt.getTime() - now).toBeGreaterThanOrEqual(TTL * 1000);
    }
  });

  it('nunca entrega mais que dois TTLs, que é o teto do estrago', () => {
    for (const offset of [0, 1, HOUR / 3, HOUR - 1]) {
      const now = 1_800_000_000_000 + offset;
      const { expiresAt } = signedUrlWindow(TTL, now);

      expect(expiresAt.getTime() - now).toBeLessThanOrEqual(2 * TTL * 1000);
    }
  });

  it('assina a partir do início da janela, não de agora', () => {
    const start = 1_800_000_000_000 - (1_800_000_000_000 % HOUR);
    const { signedAt } = signedUrlWindow(TTL, start + 1234);

    expect(signedAt.getTime()).toBe(start);
  });
});
