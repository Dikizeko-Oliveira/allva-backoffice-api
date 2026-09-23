import { envSchema } from './env';

/**
 * Proves the boot guard fires through the *real* schema, not just through the pure
 * rules in `config-readiness.spec.ts`. `EnvModule` calls `envSchema.parse`, so a
 * failure here is exactly what aborts startup.
 */

/** Minimum env that satisfies every unconditionally-critical field. */
const BASE = {
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db?schema=public',
  JWT_SECRET_KEY: 'x'.repeat(32),
  JWT_EXPIRES_IN: '1d',
  REDIS_URL: 'redis://localhost:6379',
  OPENAI_API_KEY: 'sk-test',
  FRONTEND_URL: 'http://localhost:3000',
  GOOGLE_CLIENT_ID: 'google-client-id',
  META_APP_ID: 'meta-app-id',
  META_APP_SECRET: 'meta-app-secret',
  META_CALLBACK_URL: 'http://localhost:3333/cb',
  INTEGRATION_TOKEN_ENCRYPTION_KEY: 'y'.repeat(32),
};

/** Paths reported by a failed parse. */
function failedPaths(env: Record<string, unknown>): string[] {
  const result = envSchema.safeParse(env);
  if (result.success) return [];
  return result.error.issues.map((issue) => issue.path.join('.'));
}

/** BASE without `key` — how each "is this variable required?" case is built. */
function baseWithout(key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...BASE };
  delete copy[key];
  return copy;
}

describe('envSchema', () => {
  it('accepts a development env without any billing webhook secret', () => {
    expect(envSchema.safeParse(BASE).success).toBe(true);
  });

  it('applies development as the default NODE_ENV', () => {
    const result = envSchema.parse(BASE);

    expect(result.NODE_ENV).toBe('development');
  });

  describe('unconditionally critical', () => {
    it.each([
      'DATABASE_URL',
      'JWT_SECRET_KEY',
      'REDIS_URL',
      'INTEGRATION_TOKEN_ENCRYPTION_KEY',
      'FRONTEND_URL',
    ])('refuses to parse without %s', (key) => {
      expect(failedPaths(baseWithout(key))).toContain(key);
    });

    it.each(['JWT_SECRET_KEY', 'INTEGRATION_TOKEN_ENCRYPTION_KEY'])(
      'rejects a %s shorter than 32 characters',
      (key) => {
        expect(failedPaths({ ...BASE, [key]: 'too-short' })).toContain(key);
      },
    );
  });

  describe('conditionally critical — the boot guard (D-3)', () => {
    it('refuses a production boot when Stripe has no webhook secret', () => {
      expect(
        failedPaths({
          ...BASE,
          NODE_ENV: 'production',
          STRIPE_SECRET_KEY: 'sk_live_x',
        }),
      ).toContain('STRIPE_WEBHOOK_SECRET');
    });

    it('accepts a production boot with the secrets in place', () => {
      const result = envSchema.safeParse({
        ...BASE,
        NODE_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_live_x',
        STRIPE_WEBHOOK_SECRET: 'whsec_x',
      });

      expect(result.success).toBe(true);
    });

    it('surfaces the reason, so a failed deploy is self-explanatory', () => {
      const result = envSchema.safeParse({
        ...BASE,
        NODE_ENV: 'production',
        STRIPE_SECRET_KEY: 'sk_live_x',
      });

      expect(result.success).toBe(false);
      if (result.success) return;
      expect(result.error.issues[0].message).toMatch(/signature/i);
    });
  });

  describe('optional tier never blocks the boot', () => {
    it('parses with no AI, storage, email or ads credentials at all', () => {
      const result = envSchema.safeParse({
        ...BASE,
        ANTHROPIC_API_KEY: undefined,
      });

      expect(result.success).toBe(true);
    });

    it('coerces VIDEO_PREVIEW_ENABLED="false" to a real boolean', () => {
      // Plain z.coerce.boolean() treats any non-empty string — including "false" —
      // as true, which would make the kill switch a no-op.
      expect(
        envSchema.parse({ ...BASE, VIDEO_PREVIEW_ENABLED: 'false' })
          .VIDEO_PREVIEW_ENABLED,
      ).toBe(false);
      expect(envSchema.parse(BASE).VIDEO_PREVIEW_ENABLED).toBe(true);
    });

    it('TIKTOK_SMART_PLUS_ENABLED nasce desligado e só liga com "true"', () => {
      // D24: a leitura Smart+ não foi validada contra conta real. Ausente ou
      // "false", nenhuma rota /smart_plus/* é chamada.
      expect(envSchema.parse(BASE).TIKTOK_SMART_PLUS_ENABLED).toBe(false);
      expect(
        envSchema.parse({ ...BASE, TIKTOK_SMART_PLUS_ENABLED: 'false' })
          .TIKTOK_SMART_PLUS_ENABLED,
      ).toBe(false);
      expect(
        envSchema.parse({ ...BASE, TIKTOK_SMART_PLUS_ENABLED: 'true' })
          .TIKTOK_SMART_PLUS_ENABLED,
      ).toBe(true);
    });

    /**
     * D-1 and D-2: these used to fail the boot. An AI provider key has fallback and
     * cooldown behind it, and every provider credential consumer already declares
     * itself unavailable — so none of them justifies refusing to start.
     */
    it.each([
      'OPENAI_API_KEY',
      'GOOGLE_CLIENT_ID',
      'META_APP_ID',
      'META_APP_SECRET',
      'META_CALLBACK_URL',
    ])('no longer fails the boot without %s', (key) => {
      expect(envSchema.safeParse(baseWithout(key)).success).toBe(true);
    });

    it('boots with nothing but the unconditionally critical variables', () => {
      const result = envSchema.safeParse({
        DATABASE_URL: BASE.DATABASE_URL,
        JWT_SECRET_KEY: BASE.JWT_SECRET_KEY,
        REDIS_URL: BASE.REDIS_URL,
        INTEGRATION_TOKEN_ENCRYPTION_KEY: BASE.INTEGRATION_TOKEN_ENCRYPTION_KEY,
        FRONTEND_URL: BASE.FRONTEND_URL,
      });

      expect(result.success).toBe(true);
    });

    // D-4: not a secret and not an infra decision, so it gets a default. It must be
    // a real value, because `String(undefined)` would reach jose as "undefined".
    it('defaults JWT_EXPIRES_IN instead of requiring it', () => {
      const result = envSchema.parse(baseWithout('JWT_EXPIRES_IN'));

      expect(result.JWT_EXPIRES_IN).toBe('7d');
    });

    it('keeps an explicit JWT_EXPIRES_IN over the default', () => {
      expect(
        envSchema.parse({ ...BASE, JWT_EXPIRES_IN: '15m' }).JWT_EXPIRES_IN,
      ).toBe('15m');
    });
  });

  /**
   * RP5 — as duas trancas da escrita em plataforma nascem fechadas. O teste
   * existe porque o custo de errar o default aqui não é um bug: é escrita real
   * em mídia paga numa instalação que não pediu por ela.
   */
  describe('escrita em plataforma (A2-S7)', () => {
    it('nasce desligada e em dry-run', () => {
      const result = envSchema.parse(BASE);

      expect(result.PLATFORM_ACTIONS_ENABLED).toBe(false);
      expect(result.PLATFORM_ACTIONS_DRY_RUN_ONLY).toBe(true);
    });

    it('traz um limite de rajada por organização (C10)', () => {
      // Blast radius de R1: o teto diário responde "quanto", este responde "a
      // que velocidade". Sem default, uma instalação sem a variável escreveria
      // sem limite de taxa nenhum.
      expect(
        envSchema.parse(BASE).PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE,
      ).toBe(30);
      expect(
        failedPaths({
          ...BASE,
          PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE: '0',
        }),
      ).toContain('PLATFORM_ACTIONS_ORG_RATE_LIMIT_PER_MINUTE');
    });

    it('exige a palavra exata para destravar', () => {
      // `z.coerce.boolean()` trataria "false" como true — e a tranca que abre
      // sozinha ao ser configurada errado é pior que tranca nenhuma, porque
      // ninguém a confere depois.
      expect(
        envSchema.parse({ ...BASE, PLATFORM_ACTIONS_DRY_RUN_ONLY: 'false' })
          .PLATFORM_ACTIONS_DRY_RUN_ONLY,
      ).toBe(false);
      expect(
        failedPaths({ ...BASE, PLATFORM_ACTIONS_ENABLED: 'sim' }),
      ).toContain('PLATFORM_ACTIONS_ENABLED');
    });
  });

  /**
   * The Graph API version is configuration because it expires on Meta's
   * calendar, not ours — v19.0 went unavailable on 2026-05-21 while the number
   * sat hardcoded in the provider. Being able to roll it forward (or back)
   * without a deploy is the point, and it matters more once the same provider
   * writes to the platform.
   */
  describe('STORAGE_PROVIDER', () => {
    it('defaults to GCS', () => {
      expect(envSchema.parse(BASE).STORAGE_PROVIDER).toBe('GCS');
    });

    /**
     * Escolha de infraestrutura escrita à mão num painel de deploy: derrubar o
     * boot por um `gcs` minúsculo puniria a digitação, não a configuração.
     */
    it.each(['gcs', ' GCS ', 'Gcs'])(
      'normaliza caixa e espaço (%p)',
      (value) => {
        expect(
          envSchema.parse({ ...BASE, STORAGE_PROVIDER: value })
            .STORAGE_PROVIDER,
        ).toBe('GCS');
      },
    );

    it('aceita S3 como alternativa', () => {
      expect(
        envSchema.parse({ ...BASE, STORAGE_PROVIDER: 's3' }).STORAGE_PROVIDER,
      ).toBe('S3');
    });

    /**
     * O caso que **não** pode cair no padrão: um valor desconhecido significa
     * que alguém pediu outra nuvem, e mandar os arquivos para o GCS em silêncio
     * seria atender um pedido diferente do que foi feito.
     */
    it.each(['azure', 'gcp', ''])(
      'recusa o boot com um provedor que não existe (%p)',
      (value) => {
        expect(failedPaths({ ...BASE, STORAGE_PROVIDER: value })).toContain(
          'STORAGE_PROVIDER',
        );
      },
    );

    it('não exige nenhuma credencial de storage para subir', () => {
      // Camada opcional (P-6): o provider recusa a chamada com
      // STORAGE_NOT_CONFIGURED e o boot segue.
      expect(
        envSchema.safeParse({ ...BASE, GCS_BUCKET: undefined }).success,
      ).toBe(true);
    });
  });

  describe('META_API_VERSION', () => {
    it('defaults to a version that is still available', () => {
      expect(envSchema.parse(BASE).META_API_VERSION).toBe('v25.0');
    });

    it('accepts an explicit bump', () => {
      expect(
        envSchema.parse({ ...BASE, META_API_VERSION: 'v26.0' })
          .META_API_VERSION,
      ).toBe('v26.0');
    });

    /**
     * A malformed version does not fail anywhere useful: it fails at Meta, as a
     * 404 with no explanation, on every call. Failing the boot instead makes the
     * typo cost one restart rather than one incident.
     */
    it.each(['19.0', 'v19', 'latest', 'v', ''])(
      'refuses the boot on a malformed version (%s)',
      (version) => {
        expect(failedPaths({ ...BASE, META_API_VERSION: version })).toContain(
          'META_API_VERSION',
        );
      },
    );
  });
});
