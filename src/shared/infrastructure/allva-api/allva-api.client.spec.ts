import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';
import { AllvaApiClient } from './allva-api.client';

const SECRET = 'segredo-compartilhado-com-mais-de-32-caracteres';

function build(secret?: string) {
  const env = {
    get: (key: string) =>
      key === 'ALLVA_API_URL'
        ? 'http://allva-api.test'
        : key === 'TRUSTED_CLIENT_IP_SECRET'
          ? secret
          : undefined,
  } as unknown as EnvService;
  const context = new RequestContextService();
  return { client: new AllvaApiClient(env, context), context };
}

async function headersSent(
  secret: string | undefined,
  store: { correlationId?: string; clientIp?: string },
) {
  const fetchMock = jest
    .fn()
    .mockResolvedValue(new Response('{}', { status: 200 }));
  global.fetch = fetchMock as unknown as typeof fetch;
  const { client, context } = build(secret);

  await context.run(store, () =>
    client.request('/api/v1/admin/overview', { token: 't' }),
  );

  return fetchMock.mock.calls[0][1].headers as Record<string, string>;
}

describe('AllvaApiClient — IP do operador (GAP-033)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('com o segredo, repassa o IP do operador provado', async () => {
    const headers = await headersSent(SECRET, {
      correlationId: 'c-1',
      clientIp: '189.10.20.30',
    });

    expect(headers['x-allva-client-ip']).toBe('189.10.20.30');
    expect(headers['x-allva-proxy-secret']).toBe(SECRET);
    expect(headers['x-correlation-id']).toBe('c-1');
  });

  it('sem o segredo, não declara IP nenhum', async () => {
    const headers = await headersSent(undefined, { clientIp: '189.10.20.30' });

    expect(headers).not.toHaveProperty('x-allva-client-ip');
    expect(headers).not.toHaveProperty('x-allva-proxy-secret');
  });

  it('fora de uma requisição (sem IP), não declara nada', async () => {
    const headers = await headersSent(SECRET, {});

    expect(headers).not.toHaveProperty('x-allva-client-ip');
  });
});

describe('AllvaApiClient — Idempotency-Key (GAP-043)', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  async function headersFor(idempotencyKey?: string) {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { client } = build();

    await client.request('/api/v1/admin/contracts', {
      method: 'POST',
      token: 't',
      body: {},
      idempotencyKey,
    });

    return fetchMock.mock.calls[0][1].headers as Record<string, string>;
  }

  it('repassa a chave quando pedida', async () => {
    expect((await headersFor('contract-draft:d-1'))['Idempotency-Key']).toBe(
      'contract-draft:d-1',
    );
  });

  it('sem chave, não inventa uma', async () => {
    expect(await headersFor()).not.toHaveProperty('Idempotency-Key');
  });
});
