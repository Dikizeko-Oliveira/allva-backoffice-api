/**
 * The critical-vs-optional rule from `docs/env-secrets.md` (PLAN.md P-6), as pure
 * functions so it can be unit tested without booting Nest.
 *
 * Two tiers live here:
 *
 * - `findProductionBlockers` — the **conditionally critical** ones: variables that
 *   are optional in development but must be present in production. Wired into
 *   `envSchema` via `superRefine`, so a missing one fails `envSchema.parse` and the
 *   process never starts. Unconditionally critical variables need nothing here —
 *   they are already non-optional in the schema itself.
 *
 * - `findDegradedFeatures` — the **optional** ones: absent means a feature is off,
 *   never that the process should die. Reported at boot by
 *   `ConfigReadinessService`. Sprint 5 removed exactly one crash of this kind
 *   (`AnthropicClient` dying over an optional key); nothing here may reintroduce it.
 */

export type ConfigBlocker = {
  /** Env var that must be set. Becomes the Zod issue path. */
  key: string;
  message: string;
};

export type DegradedFeature = {
  /** Human-readable feature name, e.g. "Stripe checkout". */
  feature: string;
  /** The variables whose absence caused it. */
  missing: string[];
  /** What stops working. */
  impact: string;
};

/** Only the fields the rules actually read — avoids importing `Env` (cycle). */
export type ReadinessInput = {
  NODE_ENV?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  API_PUBLIC_URL?: string;
  STORAGE_PROVIDER?: string;
  GCS_PROJECT_ID?: string;
  GCS_BUCKET?: string;
  GCS_CLIENT_EMAIL?: string;
  GCS_PRIVATE_KEY?: string;
  GCS_KEY_FILENAME?: string;
  AWS_REGION?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_S3_BUCKET?: string;
  EMAIL_PROVIDER?: string;
  SMTP_HOST?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  BREVO_API_KEY?: string;
  ALLVA_SUPPORT_EMAIL?: string;
  GOOGLE_ADS_CLIENT_ID?: string;
  GOOGLE_ADS_CLIENT_SECRET?: string;
  GOOGLE_ADS_REDIRECT_URI?: string;
  GOOGLE_ADS_DEVELOPER_TOKEN?: string;
  TIKTOK_ADS_CLIENT_ID?: string;
  TIKTOK_ADS_CLIENT_SECRET?: string;
  TIKTOK_ADS_REDIRECT_URI?: string;
  GOOGLE_CLIENT_ID?: string;
  META_APP_ID?: string;
  META_APP_SECRET?: string;
  META_CALLBACK_URL?: string;
};

function isProduction(env: ReadinessInput): boolean {
  return env.NODE_ENV === 'production';
}

/** Treats whitespace-only as absent: a blank value in a dashboard is not config. */
function isSet(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

/**
 * Names of the entries whose value is unset, in declaration order — so a log line
 * lists the variables in the order a reader would expect to set them.
 */
function missingKeys(entries: Record<string, string | undefined>): string[] {
  return Object.entries(entries)
    .filter(([, value]) => !isSet(value))
    .map(([key]) => key);
}

/**
 * Variables that must be present in production. Empty array in every other
 * environment — requiring webhook secrets locally would stop any dev from
 * starting the app, which is how "critical" lists get deleted.
 */
export function findProductionBlockers(env: ReadinessInput): ConfigBlocker[] {
  if (!isProduction(env)) return [];

  const blockers: ConfigBlocker[] = [];

  if (isSet(env.STRIPE_SECRET_KEY) && !isSet(env.STRIPE_WEBHOOK_SECRET)) {
    blockers.push({
      key: 'STRIPE_WEBHOOK_SECRET',
      message:
        'STRIPE_WEBHOOK_SECRET is required in production when STRIPE_SECRET_KEY is set: ' +
        'without it every Stripe webhook fails signature verification and billing stops reconciling.',
    });
  }

  return blockers;
}

/**
 * Features that will be silently off. Never a boot failure — the point is that
 * "degrades quietly" stops being quiet.
 */
export function findDegradedFeatures(env: ReadinessInput): DegradedFeature[] {
  const degraded: DegradedFeature[] = [];

  const aiKeys = [
    ['OPENAI_API_KEY', env.OPENAI_API_KEY],
    ['ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY],
  ] as const;
  const missingAi = aiKeys
    .filter(([, value]) => !isSet(value))
    .map(([key]) => key);

  if (missingAi.length === aiKeys.length) {
    degraded.push({
      feature: 'AI analysis',
      missing: missingAi,
      impact:
        'no AI provider is configured; campaign analysis and copy generation will fail at request time',
    });
  } else if (missingAi.length > 0) {
    degraded.push({
      feature: 'AI provider fallback',
      missing: missingAi,
      impact:
        'only one provider is configured, so there is nothing to fall back to when it is saturated or rate limited',
    });
  }

  degraded.push(...findDegradedStorage(env));

  if (!isSet(env.API_PUBLIC_URL)) {
    degraded.push({
      feature: 'Report download link in email',
      missing: ['API_PUBLIC_URL'],
      impact:
        'the report email links to the report inside the app instead of downloading the PDF directly; nothing else is affected',
    });
  }

  // `console` is the documented default and a deliberate choice, not degradation.
  const provider = env.EMAIL_PROVIDER ?? 'console';

  if (provider === 'smtp') {
    const missingSmtp = missingKeys({
      SMTP_HOST: env.SMTP_HOST,
      SMTP_USER: env.SMTP_USER,
      SMTP_PASS: env.SMTP_PASS,
    });

    if (missingSmtp.length > 0) {
      degraded.push({
        feature: 'Email delivery (SMTP)',
        missing: missingSmtp,
        impact:
          'EMAIL_PROVIDER=smtp but credentials are incomplete; verification, password reset and alert emails will not be sent',
      });
    }
  }

  if (provider === 'brevo' && !isSet(env.BREVO_API_KEY)) {
    degraded.push({
      feature: 'Email delivery (Brevo)',
      missing: ['BREVO_API_KEY'],
      impact:
        'EMAIL_PROVIDER=brevo without an API key; verification, password reset and alert emails will not be sent',
    });
  }

  if (provider === 'console' && isProduction(env)) {
    degraded.push({
      feature: 'Email delivery',
      missing: ['EMAIL_PROVIDER'],
      impact:
        'running in production with EMAIL_PROVIDER=console: emails are written to the log instead of being delivered',
    });
  }

  if (!isSet(env.STRIPE_SECRET_KEY)) {
    degraded.push({
      feature: 'Stripe checkout',
      missing: ['STRIPE_SECRET_KEY'],
      impact: 'Stripe plans and checkout are unavailable',
    });
  }

  if (!isSet(env.ALLVA_SUPPORT_EMAIL)) {
    degraded.push({
      feature: 'Support message delivery',
      missing: ['ALLVA_SUPPORT_EMAIL'],
      impact:
        'the support drawer answers SUPPORT_EMAIL_NOT_CONFIGURED instead of sending the message',
    });
  }

  const missingGoogleAds = missingKeys({
    GOOGLE_ADS_CLIENT_ID: env.GOOGLE_ADS_CLIENT_ID,
    GOOGLE_ADS_CLIENT_SECRET: env.GOOGLE_ADS_CLIENT_SECRET,
    GOOGLE_ADS_REDIRECT_URI: env.GOOGLE_ADS_REDIRECT_URI,
    GOOGLE_ADS_DEVELOPER_TOKEN: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });

  if (missingGoogleAds.length > 0) {
    degraded.push({
      feature: 'Google Ads integration',
      missing: missingGoogleAds,
      impact:
        'accounts cannot connect Google Ads; the provider reports itself unconfigured',
    });
  }

  const missingTikTokAds = missingKeys({
    TIKTOK_ADS_CLIENT_ID: env.TIKTOK_ADS_CLIENT_ID,
    TIKTOK_ADS_CLIENT_SECRET: env.TIKTOK_ADS_CLIENT_SECRET,
    TIKTOK_ADS_REDIRECT_URI: env.TIKTOK_ADS_REDIRECT_URI,
  });

  if (missingTikTokAds.length > 0) {
    degraded.push({
      feature: 'TikTok Ads integration',
      missing: missingTikTokAds,
      impact:
        'accounts cannot connect TikTok Ads; the provider reports itself unconfigured',
    });
  }

  const missingMeta = missingKeys({
    META_APP_ID: env.META_APP_ID,
    META_APP_SECRET: env.META_APP_SECRET,
    META_CALLBACK_URL: env.META_CALLBACK_URL,
  });

  // These stopped being boot-critical in D-2, so their absence has to be loud
  // here instead — losing Facebook sign-in silently would be worse than the crash
  // it replaced.
  if (missingMeta.length > 0) {
    degraded.push({
      feature: 'Meta Ads integration & Facebook sign-in',
      missing: missingMeta,
      impact:
        'accounts cannot connect Meta Ads, and Facebook SSO answers FACEBOOK_SSO_NOT_CONFIGURED',
    });
  }

  if (!isSet(env.GOOGLE_CLIENT_ID)) {
    degraded.push({
      feature: 'Google sign-in',
      missing: ['GOOGLE_CLIENT_ID'],
      impact:
        'Google SSO answers GOOGLE_SSO_NOT_CONFIGURED; accounts must sign in with a password',
    });
  }

  return degraded;
}

/**
 * Storage degradation, for the **active** provider only.
 *
 * Before `STORAGE_PROVIDER` existed there was one provider and the rule could
 * name AWS unconditionally. Now, listing both would make every correct GCS
 * deploy report four missing AWS variables — and a warning that fires when
 * nothing is wrong is a warning people learn to skip past, which is how the
 * real one gets missed.
 */
function findDegradedStorage(env: ReadinessInput): DegradedFeature[] {
  const degraded: DegradedFeature[] = [];

  // Mirrors the schema default: absent means GCS.
  const provider = (env.STORAGE_PROVIDER ?? 'GCS').trim().toUpperCase();

  if (provider === 'S3') {
    const missing = missingKeys({
      AWS_REGION: env.AWS_REGION,
      AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY,
      AWS_S3_BUCKET: env.AWS_S3_BUCKET,
    });

    if (missing.length > 0) {
      degraded.push({
        feature: 'S3 storage',
        missing,
        impact:
          'STORAGE_PROVIDER=S3 with incomplete credentials; creative uploads, video previews and report PDFs will fail with STORAGE_NOT_CONFIGURED',
      });
    }

    return degraded;
  }

  const missing = missingKeys({
    GCS_PROJECT_ID: env.GCS_PROJECT_ID,
    GCS_BUCKET: env.GCS_BUCKET,
  });

  if (missing.length > 0) {
    degraded.push({
      feature: 'GCS storage',
      missing,
      impact:
        'creative uploads, video previews and report PDFs will fail with STORAGE_NOT_CONFIGURED',
    });
  }

  // Explicit credentials are optional — Application Default Credentials are the
  // recommended setup inside Google Cloud, so their absence is not reported.
  // *Half* a key pair is different: it is never a valid configuration, and it
  // fails at signing time with an error that says nothing about which half.
  const hasKeyFile = isSet(env.GCS_KEY_FILENAME);
  const hasEmail = isSet(env.GCS_CLIENT_EMAIL);
  const hasPrivateKey = isSet(env.GCS_PRIVATE_KEY);

  if (!hasKeyFile && hasEmail !== hasPrivateKey) {
    degraded.push({
      feature: 'GCS storage credentials',
      missing: [hasEmail ? 'GCS_PRIVATE_KEY' : 'GCS_CLIENT_EMAIL'],
      impact:
        'only half of the service account key pair is set, so it is ignored and the SDK falls back to Application Default Credentials',
    });
  }

  return degraded;
}
