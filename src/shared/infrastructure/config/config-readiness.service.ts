import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EnvService } from './env.service';
import {
  DegradedFeature,
  ReadinessInput,
  findDegradedFeatures,
} from './config-readiness';

/**
 * Makes "degrades quietly" stop being quiet (PLAN.md P-6, Sprint 6 Ops readiness).
 *
 * The conditionally-critical tier already failed the boot inside `envSchema` by the
 * time this runs. What is left are the optional variables: their absence turns a
 * feature off, and the only defensible way to ship that is to say so out loud, once,
 * at startup.
 *
 * This service must never throw. Sprint 5 removed a boot crash caused by an optional
 * key (`AnthropicClient`), and a readiness *reporter* that can kill the process would
 * reintroduce the same class of failure with extra steps.
 */
@Injectable()
export class ConfigReadinessService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ConfigReadinessService.name);

  constructor(private readonly env: EnvService) {}

  onApplicationBootstrap(): void {
    try {
      this.report(findDegradedFeatures(this.readEnv()));
    } catch (error) {
      this.logger.error(
        `config.readiness_check_failed: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  private report(degraded: DegradedFeature[]): void {
    if (degraded.length === 0) {
      this.logger.log(
        'config.readiness_ok — every optional feature is configured',
      );
      return;
    }

    const isProduction = this.value('NODE_ENV') === 'production';

    this.logger.warn(
      `config.degraded_features count=${degraded.length}` +
        (isProduction ? ' env=production' : ''),
    );

    for (const { feature, missing, impact } of degraded) {
      // One line per feature: greppable, and names the variable to set.
      const line = `config.degraded feature="${feature}" missing=${missing.join(',')} — ${impact}`;

      // In production a degraded feature is very likely a deploy mistake; outside
      // it, an unconfigured integration is the normal state of a dev machine.
      if (isProduction) this.logger.error(line);
      else this.logger.log(line);
    }
  }

  /** Reads the subset of variables the rules actually inspect. */
  private readEnv(): ReadinessInput {
    return {
      NODE_ENV: this.value('NODE_ENV'),
      STRIPE_SECRET_KEY: this.value('STRIPE_SECRET_KEY'),
      STRIPE_WEBHOOK_SECRET: this.value('STRIPE_WEBHOOK_SECRET'),
      OPENAI_API_KEY: this.value('OPENAI_API_KEY'),
      ANTHROPIC_API_KEY: this.value('ANTHROPIC_API_KEY'),
      API_PUBLIC_URL: this.value('API_PUBLIC_URL'),
      STORAGE_PROVIDER: this.value('STORAGE_PROVIDER'),
      GCS_PROJECT_ID: this.value('GCS_PROJECT_ID'),
      GCS_BUCKET: this.value('GCS_BUCKET'),
      GCS_CLIENT_EMAIL: this.value('GCS_CLIENT_EMAIL'),
      GCS_PRIVATE_KEY: this.value('GCS_PRIVATE_KEY'),
      GCS_KEY_FILENAME: this.value('GCS_KEY_FILENAME'),
      AWS_REGION: this.value('AWS_REGION'),
      AWS_ACCESS_KEY_ID: this.value('AWS_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: this.value('AWS_SECRET_ACCESS_KEY'),
      AWS_S3_BUCKET: this.value('AWS_S3_BUCKET'),
      EMAIL_PROVIDER: this.value('EMAIL_PROVIDER'),
      SMTP_HOST: this.value('SMTP_HOST'),
      SMTP_USER: this.value('SMTP_USER'),
      SMTP_PASS: this.value('SMTP_PASS'),
      BREVO_API_KEY: this.value('BREVO_API_KEY'),
      ALLVA_SUPPORT_EMAIL: this.value('ALLVA_SUPPORT_EMAIL'),
      GOOGLE_ADS_CLIENT_ID: this.value('GOOGLE_ADS_CLIENT_ID'),
      GOOGLE_ADS_CLIENT_SECRET: this.value('GOOGLE_ADS_CLIENT_SECRET'),
      GOOGLE_ADS_REDIRECT_URI: this.value('GOOGLE_ADS_REDIRECT_URI'),
      GOOGLE_ADS_DEVELOPER_TOKEN: this.value('GOOGLE_ADS_DEVELOPER_TOKEN'),
      TIKTOK_ADS_CLIENT_ID: this.value('TIKTOK_ADS_CLIENT_ID'),
      TIKTOK_ADS_CLIENT_SECRET: this.value('TIKTOK_ADS_CLIENT_SECRET'),
      TIKTOK_ADS_REDIRECT_URI: this.value('TIKTOK_ADS_REDIRECT_URI'),
      GOOGLE_CLIENT_ID: this.value('GOOGLE_CLIENT_ID'),
      META_APP_ID: this.value('META_APP_ID'),
      META_APP_SECRET: this.value('META_APP_SECRET'),
      META_CALLBACK_URL: this.value('META_CALLBACK_URL'),
    };
  }

  /**
   * The schema mixes strings with booleans and numbers, and the rules only reason
   * about presence of string values — so anything non-string reads as absent rather
   * than being coerced into a misleading "configured".
   */
  private value(key: Parameters<EnvService['get']>[0]): string | undefined {
    const raw = this.env.get(key);

    return typeof raw === 'string' ? raw : undefined;
  }
}
