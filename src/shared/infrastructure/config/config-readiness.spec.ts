import {
  DegradedFeature,
  ReadinessInput,
  findDegradedFeatures,
  findProductionBlockers,
} from './config-readiness';

/** A production env with billing correctly wired. */
const PRODUCTION_OK: ReadinessInput = {
  NODE_ENV: 'production',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
};

function keysOf(env: ReadinessInput): string[] {
  return findProductionBlockers(env).map((blocker) => blocker.key);
}

describe('findProductionBlockers', () => {
  it('blocks nothing when production is fully configured', () => {
    expect(findProductionBlockers(PRODUCTION_OK)).toEqual([]);
  });

  // The D-3 finding: a billing webhook that cannot verify signatures accepts a
  // forged event, and a forged billing event grants paid access.
  it('blocks a production boot missing the Stripe webhook secret', () => {
    expect(
      keysOf({ ...PRODUCTION_OK, STRIPE_WEBHOOK_SECRET: undefined }),
    ).toEqual(['STRIPE_WEBHOOK_SECRET']);
  });

  // An unconfigured provider has no endpoint worth protecting, so demanding its
  // secret would block deploys for a feature nobody enabled.
  it('does not require the webhook secret when Stripe is not configured', () => {
    expect(keysOf({ NODE_ENV: 'production' })).toEqual([]);
  });

  it.each(['development', 'test', 'staging', undefined])(
    'blocks nothing when NODE_ENV is %s',
    (nodeEnv) => {
      // Requiring webhook secrets locally is how a "critical" list gets deleted in
      // week one.
      expect(
        keysOf({
          NODE_ENV: nodeEnv,
          STRIPE_SECRET_KEY: 'sk_test_x',
        }),
      ).toEqual([]);
    },
  );

  it('treats a whitespace-only secret as absent', () => {
    expect(keysOf({ ...PRODUCTION_OK, STRIPE_WEBHOOK_SECRET: '   ' })).toEqual([
      'STRIPE_WEBHOOK_SECRET',
    ]);
  });

  it('explains the consequence, not just the missing name', () => {
    const [blocker] = findProductionBlockers({
      ...PRODUCTION_OK,
      STRIPE_WEBHOOK_SECRET: undefined,
    });

    expect(blocker.message).toContain('signature verification');
  });
});

describe('findDegradedFeatures', () => {
  /** Feature names reported for a given env. */
  function featuresOf(env: ReadinessInput): string[] {
    return findDegradedFeatures(env).map((entry) => entry.feature);
  }

  it('reports nothing when every optional feature is configured', () => {
    expect(
      findDegradedFeatures({
        ...PRODUCTION_OK,
        OPENAI_API_KEY: 'sk-x',
        ANTHROPIC_API_KEY: 'sk-ant-x',
        API_PUBLIC_URL: 'https://api.allva.app',
        GCS_PROJECT_ID: 'allva-prod',
        GCS_BUCKET: 'allva-media',
        EMAIL_PROVIDER: 'brevo',
        BREVO_API_KEY: 'xkeysib-x',
        ALLVA_SUPPORT_EMAIL: 'suporte@allva.com.br',
        GOOGLE_ADS_CLIENT_ID: 'a',
        GOOGLE_ADS_CLIENT_SECRET: 'b',
        GOOGLE_ADS_REDIRECT_URI: 'https://x/cb',
        GOOGLE_ADS_DEVELOPER_TOKEN: 'd',
        TIKTOK_ADS_CLIENT_ID: 'a',
        TIKTOK_ADS_CLIENT_SECRET: 'b',
        TIKTOK_ADS_REDIRECT_URI: 'https://x/cb',
        GOOGLE_CLIENT_ID: 'google-client',
        META_APP_ID: 'meta-app',
        META_APP_SECRET: 'meta-secret',
        META_CALLBACK_URL: 'https://x/meta/cb',
      }),
    ).toEqual([]);
  });

  // D-2 made these optional instead of boot-critical. Losing Google or Facebook
  // sign-in silently would be worse than the boot crash it replaced, so the
  // degradation has to be reported.
  it('reports Google sign-in as degraded without GOOGLE_CLIENT_ID', () => {
    expect(featuresOf({})).toContain('Google sign-in');
  });

  it('reports Meta as degraded without its credentials', () => {
    expect(featuresOf({})).toContain('Meta Ads integration & Facebook sign-in');
  });

  it('names only the Meta variables that are actually missing', () => {
    const [meta] = findDegradedFeatures({
      META_APP_ID: 'meta-app',
      META_CALLBACK_URL: 'https://x/meta/cb',
    }).filter((entry) => entry.feature.startsWith('Meta Ads'));

    expect(meta.missing).toEqual(['META_APP_SECRET']);
  });

  it('reports support message delivery as degraded without ALLVA_SUPPORT_EMAIL', () => {
    expect(featuresOf({})).toContain('Support message delivery');
    expect(
      featuresOf({ ALLVA_SUPPORT_EMAIL: 'suporte@allva.com.br' }),
    ).not.toContain('Support message delivery');
  });

  it('distinguishes "no AI provider" from "no fallback"', () => {
    expect(featuresOf({ OPENAI_API_KEY: 'sk-x' })).toContain(
      'AI provider fallback',
    );
    expect(featuresOf({})).toContain('AI analysis');
    expect(featuresOf({})).not.toContain('AI provider fallback');
  });

  describe('storage', () => {
    /** Só o provedor ativo é cobrado — ver `findDegradedStorage`. */
    function storageOf(env: ReadinessInput): DegradedFeature[] {
      return findDegradedFeatures(env).filter((entry) =>
        entry.feature.includes('storage'),
      );
    }

    it('names the missing variables so the log is actionable', () => {
      const [storage] = storageOf({
        STORAGE_PROVIDER: 'S3',
        AWS_REGION: 'us-east-1',
      });

      expect(storage.feature).toBe('S3 storage');
      expect(storage.missing).toEqual([
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
        'AWS_S3_BUCKET',
      ]);
      expect(storage.missing).not.toContain('AWS_REGION');
    });

    it('cobra GCS quando nada foi dito, porque é o padrão do schema', () => {
      const [storage] = storageOf({});

      expect(storage.feature).toBe('GCS storage');
      expect(storage.missing).toEqual(['GCS_PROJECT_ID', 'GCS_BUCKET']);
    });

    it.each(['gcs', ' GCS '])('normaliza %p como o schema faz', (value) => {
      expect(storageOf({ STORAGE_PROVIDER: value })[0].feature).toBe(
        'GCS storage',
      );
    });

    /**
     * O motivo de a regra olhar só o provedor ativo: cobrar as quatro variáveis
     * da AWS em todo deploy correto de GCS é aviso que dispara quando nada está
     * errado — e aviso assim é o que ensina um time a passar o olho por cima.
     */
    it('não cobra a nuvem que não está em uso', () => {
      expect(storageOf({ GCS_PROJECT_ID: 'p', GCS_BUCKET: 'b' })).toEqual([]);
      expect(
        storageOf({
          STORAGE_PROVIDER: 'S3',
          AWS_REGION: 'us-east-1',
          AWS_ACCESS_KEY_ID: 'AKIA',
          AWS_SECRET_ACCESS_KEY: 'secret',
          AWS_S3_BUCKET: 'bucket',
        }),
      ).toEqual([]);
    });

    /**
     * Application Default Credentials é o modo recomendado dentro do Google
     * Cloud. Reportar a ausência de chave explícita marcaria como degradado
     * justamente o deploy mais bem configurado.
     */
    it('trata a ausência de chave explícita como configuração normal', () => {
      expect(storageOf({ GCS_PROJECT_ID: 'p', GCS_BUCKET: 'b' })).toEqual([]);
    });

    it.each([
      [
        { GCS_CLIENT_EMAIL: 'svc@x.iam.gserviceaccount.com' },
        'GCS_PRIVATE_KEY',
      ],
      [{ GCS_PRIVATE_KEY: '-----BEGIN' }, 'GCS_CLIENT_EMAIL'],
    ])('denuncia meio par de credencial (%p)', (half, expected) => {
      // Meio par nunca é configuração válida: o SDK o ignora inteiro e cai em
      // ADC, então o sintoma é um 403 que não menciona nenhuma das duas.
      const [credentials] = storageOf({
        GCS_PROJECT_ID: 'p',
        GCS_BUCKET: 'b',
        ...half,
      });

      expect(credentials.feature).toBe('GCS storage credentials');
      expect(credentials.missing).toEqual([expected]);
    });

    it('cala sobre o par quando o arquivo da service account resolve', () => {
      expect(
        storageOf({
          GCS_PROJECT_ID: 'p',
          GCS_BUCKET: 'b',
          GCS_KEY_FILENAME: '/secrets/gcs.json',
          GCS_CLIENT_EMAIL: 'svc@x.iam.gserviceaccount.com',
        }),
      ).toEqual([]);
    });
  });

  it('avisa que o e-mail de relatório perde o download direto sem API_PUBLIC_URL', () => {
    const [link] = findDegradedFeatures({}).filter(
      (entry) => entry.feature === 'Report download link in email',
    );

    expect(link.missing).toEqual(['API_PUBLIC_URL']);
    // O impacto é limitado de propósito: o e-mail continua saindo e o link
    // continua levando ao relatório, só que dentro do app.
    expect(link.impact).toContain('inside the app');
  });

  it('cala sobre o link quando API_PUBLIC_URL existe', () => {
    expect(
      findDegradedFeatures({ API_PUBLIC_URL: 'https://api.allva.app' }).map(
        (entry) => entry.feature,
      ),
    ).not.toContain('Report download link in email');
  });

  it('flags console email delivery only in production', () => {
    expect(featuresOf({ NODE_ENV: 'production' })).toContain('Email delivery');
    // Locally, console output is the documented default, not a problem.
    expect(featuresOf({ NODE_ENV: 'development' })).not.toContain(
      'Email delivery',
    );
  });

  it.each([
    ['smtp', 'Email delivery (SMTP)'],
    ['brevo', 'Email delivery (Brevo)'],
  ])('flags %s selected without credentials', (provider, expected) => {
    expect(featuresOf({ EMAIL_PROVIDER: provider })).toContain(expected);
  });

  it('does not flag a fully configured smtp provider', () => {
    expect(
      featuresOf({
        EMAIL_PROVIDER: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_USER: 'user',
        SMTP_PASS: 'pass',
      }),
    ).not.toContain('Email delivery (SMTP)');
  });

  // The rule that Sprint 5 was built on: an absent optional key degrades, and this
  // function is the reporting half of that. It must never be able to fail a boot.
  it('is a pure report — never throws, even on a fully empty env', () => {
    expect(() => findDegradedFeatures({})).not.toThrow();
    expect(findDegradedFeatures({}).length).toBeGreaterThan(0);
  });
});
