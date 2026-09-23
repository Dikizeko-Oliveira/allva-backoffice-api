import { ServiceUnavailableException } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { GoogleAdsProvider } from './google/google-ads.provider';
import { MetaAdsProvider } from './meta/meta-ads.provider';
import { TikTokAdsProvider } from './tiktok/tiktok-ads.provider';

/**
 * Covers the credential gate all three ads providers share (PLAN.md D-5 / D-2).
 *
 * `ensureConfigured()` used to prove credentials existed only by convention — the
 * type system could not see it, so every read still looked like `string | undefined`
 * downstream. `requireConfig()` returns a validated bundle instead. These tests lock
 * the behaviour that refactor had to preserve: a provider missing any required
 * credential must report itself unconfigured and refuse work with
 * PROVIDER_NOT_CONFIGURED, never reach out with a blank one.
 *
 * This matters more since D-2, because `META_APP_*` stopped being boot-critical: the
 * gate is now the only thing standing between an unconfigured deploy and an OAuth
 * call carrying `undefined`.
 */

const GOOGLE_REQUIRED = {
  GOOGLE_ADS_CLIENT_ID: 'client-id',
  GOOGLE_ADS_CLIENT_SECRET: 'client-secret',
  GOOGLE_ADS_REDIRECT_URI: 'https://app.example.com/cb',
  GOOGLE_ADS_DEVELOPER_TOKEN: 'dev-token',
};

const TIKTOK_REQUIRED = {
  TIKTOK_ADS_CLIENT_ID: 'app-id',
  TIKTOK_ADS_CLIENT_SECRET: 'app-secret',
  TIKTOK_ADS_REDIRECT_URI: 'https://app.example.com/cb',
};

const META_REQUIRED = {
  META_APP_ID: 'meta-app-id',
  META_APP_SECRET: 'meta-app-secret',
  META_CALLBACK_URL: 'https://app.example.com/meta/cb',
};

function envWith(values: Record<string, string | undefined>): EnvService {
  // `META_API_VERSION` carries a schema default, so the real `EnvService` never
  // hands back `undefined` for it. The stub mirrors that — without the default,
  // every Graph URL built here would carry the literal string "undefined" where
  // the version goes, which is precisely what these tests assert against.
  const withDefaults = { META_API_VERSION: 'v25.0', ...values };

  return {
    get: (key: string) => withDefaults[key],
  } as unknown as EnvService;
}

const jwtService = {
  sign: jest.fn().mockResolvedValue('signed-state'),
  verify: jest.fn(),
} as never;

describe('GoogleAdsProvider credential gate', () => {
  it('is configured when every required credential is present', () => {
    const provider = new GoogleAdsProvider(
      envWith(GOOGLE_REQUIRED),
      jwtService,
    );

    expect(provider.isConfigured()).toBe(true);
  });

  it.each(Object.keys(GOOGLE_REQUIRED))(
    'is unconfigured without %s',
    (missing) => {
      const provider = new GoogleAdsProvider(
        envWith({ ...GOOGLE_REQUIRED, [missing]: undefined }),
        jwtService,
      );

      expect(provider.isConfigured()).toBe(false);
    },
  );

  it.each(Object.keys(GOOGLE_REQUIRED))(
    'treats a whitespace-only %s as missing',
    (blank) => {
      const provider = new GoogleAdsProvider(
        envWith({ ...GOOGLE_REQUIRED, [blank]: '   ' }),
        jwtService,
      );

      expect(provider.isConfigured()).toBe(false);
    },
  );

  it('refuses to build an authorization url when unconfigured', async () => {
    const provider = new GoogleAdsProvider(envWith({}), jwtService);

    await expect(
      provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
  });

  it.each([
    [
      'exchangeCodeForToken',
      (p: GoogleAdsProvider) => p.exchangeCodeForToken('code', 'state'),
    ],
    [
      'refreshAccessToken',
      (p: GoogleAdsProvider) => p.refreshAccessToken({} as never),
    ],
    ['listAdAccounts', (p: GoogleAdsProvider) => p.listAdAccounts({} as never)],
  ])('refuses %s when unconfigured', async (_name, call) => {
    const provider = new GoogleAdsProvider(envWith({}), jwtService);

    await expect(call(provider)).rejects.toThrow(ServiceUnavailableException);
  });

  it('builds the authorization url from the configured credentials', async () => {
    const provider = new GoogleAdsProvider(
      envWith({ ...GOOGLE_REQUIRED, GOOGLE_ADS_SCOPES: 'scope-a scope-b' }),
      jwtService,
    );

    const url = new URL(
      await provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    );

    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/cb',
    );
    expect(url.searchParams.get('scope')).toBe('scope-a scope-b');
    // No credential may ever reach the provider as the literal "undefined".
    expect(url.toString()).not.toContain('undefined');
  });

  it('falls back to the default scopes when GOOGLE_ADS_SCOPES is blank', async () => {
    const provider = new GoogleAdsProvider(
      envWith({ ...GOOGLE_REQUIRED, GOOGLE_ADS_SCOPES: '  ' }),
      jwtService,
    );

    const url = new URL(
      await provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    );

    expect(url.searchParams.get('scope')).toBeTruthy();
    expect(url.searchParams.get('scope')).not.toBe('  ');
  });
});

describe('TikTokAdsProvider credential gate', () => {
  it('is configured when every required credential is present', () => {
    const provider = new TikTokAdsProvider(
      envWith(TIKTOK_REQUIRED),
      jwtService,
    );

    expect(provider.isConfigured()).toBe(true);
  });

  it.each(Object.keys(TIKTOK_REQUIRED))(
    'is unconfigured without %s',
    (missing) => {
      const provider = new TikTokAdsProvider(
        envWith({ ...TIKTOK_REQUIRED, [missing]: undefined }),
        jwtService,
      );

      expect(provider.isConfigured()).toBe(false);
    },
  );

  // TIKTOK_ADS_SCOPES is genuinely optional — its absence must not disable the
  // provider, unlike the three required credentials above.
  it('stays configured without the optional scopes', () => {
    const provider = new TikTokAdsProvider(
      envWith({ ...TIKTOK_REQUIRED, TIKTOK_ADS_SCOPES: undefined }),
      jwtService,
    );

    expect(provider.isConfigured()).toBe(true);
  });

  it('refuses to build an authorization url when unconfigured', async () => {
    const provider = new TikTokAdsProvider(envWith({}), jwtService);

    await expect(
      provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    ).rejects.toMatchObject({
      response: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
  });

  it('builds the authorization url from the configured credentials', async () => {
    const provider = new TikTokAdsProvider(
      envWith({ ...TIKTOK_REQUIRED, TIKTOK_ADS_SCOPES: 'scope-a' }),
      jwtService,
    );

    const url = new URL(
      await provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    );

    expect(url.searchParams.get('app_id')).toBe('app-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/cb',
    );
    expect(url.searchParams.get('scope')).toBe('scope-a');
    expect(url.toString()).not.toContain('undefined');
  });

  it('omits the scope parameter entirely when no scopes are set', async () => {
    const provider = new TikTokAdsProvider(
      envWith(TIKTOK_REQUIRED),
      jwtService,
    );

    const url = new URL(
      await provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    );

    expect(url.searchParams.has('scope')).toBe(false);
  });
});

describe('MetaAdsProvider credential gate', () => {
  it('is configured when every required credential is present', () => {
    const provider = new MetaAdsProvider(envWith(META_REQUIRED), jwtService);

    expect(provider.isConfigured()).toBe(true);
  });

  it.each(Object.keys(META_REQUIRED))(
    'is unconfigured without %s',
    (missing) => {
      const provider = new MetaAdsProvider(
        envWith({ ...META_REQUIRED, [missing]: undefined }),
        jwtService,
      );

      expect(provider.isConfigured()).toBe(false);
    },
  );

  it.each(Object.keys(META_REQUIRED))(
    'treats a whitespace-only %s as missing',
    (blank) => {
      const provider = new MetaAdsProvider(
        envWith({ ...META_REQUIRED, [blank]: '   ' }),
        jwtService,
      );

      expect(provider.isConfigured()).toBe(false);
    },
  );

  it.each([
    [
      'getAuthorizationUrl',
      (p: MetaAdsProvider) =>
        p.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    ],
    [
      'exchangeCodeForToken',
      (p: MetaAdsProvider) => p.exchangeCodeForToken('code', 'state'),
    ],
    [
      'refreshAccessToken',
      (p: MetaAdsProvider) => p.refreshAccessToken({} as never),
    ],
    ['listAdAccounts', (p: MetaAdsProvider) => p.listAdAccounts({} as never)],
  ])('refuses %s when unconfigured', async (_name, call) => {
    const provider = new MetaAdsProvider(envWith({}), jwtService);

    await expect(call(provider)).rejects.toMatchObject({
      response: { code: 'PROVIDER_NOT_CONFIGURED' },
    });
  });

  it('builds the authorization url from the configured credentials', async () => {
    const provider = new MetaAdsProvider(envWith(META_REQUIRED), jwtService);

    const url = new URL(
      await provider.getAuthorizationUrl({ accountId: 'acc-1' } as never),
    );

    expect(url.searchParams.get('client_id')).toBe('meta-app-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/meta/cb',
    );
    expect(url.toString()).not.toContain('undefined');
  });

  /**
   * A versão da Graph API sai de configuração, não de constante — v19.0 expirou
   * em 21/05/2026 com o número fixo no código. O teste prova que a variável de
   * fato chega à URL: se o provider voltasse a hardcodar, ele falha aqui, e não
   * numa chamada à Meta meses depois.
   */
  it('constrói a URL na versão configurada da Graph API', async () => {
    const provider = new MetaAdsProvider(
      envWith({ ...META_REQUIRED, META_API_VERSION: 'v26.0' }),
      jwtService,
    );

    const url = await provider.getAuthorizationUrl({
      accountId: 'acc-1',
    } as never);

    expect(url).toContain('/v26.0/dialog/oauth');
  });
});
