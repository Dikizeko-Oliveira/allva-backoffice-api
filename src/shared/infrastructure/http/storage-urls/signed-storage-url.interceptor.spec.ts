import { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of } from 'rxjs';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { SignedStorageUrlInterceptor } from './signed-storage-url.interceptor';

const OURS = 'https://storage.googleapis.com/allva-media/creatives/arte.png';
const THEIRS = 'https://scontent.xx.fbcdn.net/v/t45/meta-thumb.jpg';

function buildStorage(
  overrides: Partial<StoragePortInterface> = {},
): StoragePortInterface {
  return {
    provider: 'gcs',
    ownsUrl: (url: string) => url.startsWith('https://storage.googleapis.com/'),
    getReadUrl: (url: string) => Promise.resolve(`${url}?assinada=1`),
    ...overrides,
  } as unknown as StoragePortInterface;
}

async function run(
  payload: unknown,
  storage: StoragePortInterface = buildStorage(),
): Promise<unknown> {
  const interceptor = new SignedStorageUrlInterceptor(storage);
  const next: CallHandler = { handle: () => of(payload) };

  return firstValueFrom(
    interceptor.intercept({} as ExecutionContext, next) as never,
  );
}

describe('SignedStorageUrlInterceptor', () => {
  it('assina a URL do nosso bucket em qualquer profundidade', async () => {
    const result = await run({
      data: { creative: { thumbnailUrl: OURS } },
      meta: {},
    });

    expect(result).toEqual({
      data: { creative: { thumbnailUrl: `${OURS}?assinada=1` } },
      meta: {},
    });
  });

  /**
   * A razão de `ownsUrl` existir: `creatives.thumbnail_url` guarda tanto a
   * miniatura que derivamos quanto a que a Meta entregou. Assinar a segunda
   * produziria uma URL para um host que não é nosso.
   */
  it('não toca em URL que não é nossa', async () => {
    expect(await run({ thumbnailUrl: THEIRS })).toEqual({
      thumbnailUrl: THEIRS,
    });
  });

  it('percorre arrays, que é o caso da listagem', async () => {
    const result = (await run([
      { thumbnailUrl: OURS },
      { thumbnailUrl: THEIRS },
      { thumbnailUrl: null },
    ])) as Array<{ thumbnailUrl: string | null }>;

    expect(result[0].thumbnailUrl).toBe(`${OURS}?assinada=1`);
    expect(result[1].thumbnailUrl).toBe(THEIRS);
    expect(result[2].thumbnailUrl).toBeNull();
  });

  it('assina uma vez só quando a mesma URL se repete', async () => {
    const getReadUrl = jest.fn(async (url: string) => `${url}?assinada=1`);

    await run(
      Array.from({ length: 20 }, () => ({ avatarUrl: OURS })),
      buildStorage({ getReadUrl }),
    );

    expect(getReadUrl).toHaveBeenCalledTimes(1);
  });

  /**
   * `fromEntries` sobre um `Date` devolveria `{}` — corromper a resposta em
   * silêncio é pior que não assinar.
   */
  it('preserva tipos que não são objeto literal', async () => {
    const createdAt = new Date('2026-08-26T00:00:00.000Z');
    const buffer = Buffer.from('pdf');

    const result = (await run({ createdAt, buffer, url: OURS })) as {
      createdAt: Date;
      buffer: Buffer;
      url: string;
    };

    expect(result.createdAt).toBe(createdAt);
    expect(result.buffer).toBe(buffer);
    expect(result.url).toBe(`${OURS}?assinada=1`);
  });

  /**
   * Miniatura quebrada é defeito visível e localizado; 500 na listagem inteira
   * por causa dela troca isso por indisponibilidade.
   */
  it('devolve a carga original quando a assinatura falha', async () => {
    const storage = buildStorage({
      getReadUrl: () => Promise.reject(new Error('signBlob denied')),
    });
    const interceptor = new SignedStorageUrlInterceptor(storage);
    jest
      .spyOn((interceptor as any).logger, 'error')
      .mockImplementation(() => undefined);

    const next: CallHandler = { handle: () => of({ url: OURS }) };
    const result = await firstValueFrom(
      interceptor.intercept({} as ExecutionContext, next) as never,
    );

    expect(result).toEqual({ url: OURS });
  });

  it('passa direto quando não há nada nosso para assinar', async () => {
    const payload = { total: 3, items: ['a', 'b'] };

    // Mesma referência: sem URL nossa, nem reconstrói o objeto.
    expect(await run(payload)).toBe(payload);
  });

  it('não estoura em carga com ciclo', async () => {
    const node: Record<string, unknown> = { url: OURS };
    node.self = node;

    await expect(run(node)).resolves.toBeDefined();
  });
});
