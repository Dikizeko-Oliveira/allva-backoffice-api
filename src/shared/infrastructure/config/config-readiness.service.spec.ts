import { EnvService } from './env.service';
import { ConfigReadinessService } from './config-readiness.service';

function buildService(values: Record<string, string | undefined>) {
  const env = {
    get: (key: string) => values[key],
  } as unknown as EnvService;

  const service = new ConfigReadinessService(env);
  const logger = (service as any).logger;

  const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
  const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(logger, 'error').mockImplementation(() => undefined);

  return { service, log, warn, error };
}

/** Every optional feature configured, so nothing is reported as degraded. */
const FULLY_CONFIGURED: Record<string, string> = {
  NODE_ENV: 'production',
  STRIPE_SECRET_KEY: 'sk_live_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_x',
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
};

describe('ConfigReadinessService', () => {
  it('reports readiness when nothing is degraded', () => {
    const h = buildService(FULLY_CONFIGURED);

    h.service.onApplicationBootstrap();

    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('config.readiness_ok'),
    );
    expect(h.error).not.toHaveBeenCalled();
  });

  it('logs one greppable line per degraded feature, naming the variable', () => {
    const h = buildService({ NODE_ENV: 'development' });

    h.service.onApplicationBootstrap();

    const lines = h.log.mock.calls
      .map(([line]) => String(line))
      .filter((line) => line.startsWith('config.degraded '));

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).toContain('missing=');
    expect(lines.join('\n')).toContain('OPENAI_API_KEY');
  });

  // Outside production an unconfigured integration is the normal state of a dev
  // machine; in production it is almost certainly a deploy mistake.
  it('escalates degraded features to error level in production', () => {
    const h = buildService({ NODE_ENV: 'production' });

    h.service.onApplicationBootstrap();

    expect(h.error).toHaveBeenCalled();
    expect(h.error.mock.calls.map(([l]) => String(l)).join('\n')).toContain(
      'config.degraded ',
    );
  });

  it('keeps degraded features at log level outside production', () => {
    const h = buildService({ NODE_ENV: 'development' });

    h.service.onApplicationBootstrap();

    expect(h.error).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('config.degraded_features'),
    );
  });

  /**
   * The whole point of the P-6 rule: Sprint 5 removed a boot crash caused by an
   * optional key. A readiness *reporter* that can throw would reintroduce it.
   */
  it('never throws, even when every read blows up', () => {
    const env = {
      get: () => {
        throw new Error('config exploded');
      },
    } as unknown as EnvService;
    const service = new ConfigReadinessService(env);
    const error = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);

    expect(() => service.onApplicationBootstrap()).not.toThrow();
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('config.readiness_check_failed'),
    );
  });

  it('ignores non-string env values instead of misreporting them', () => {
    // Booleans and numbers live in the same schema; they must not be read as
    // present-or-missing strings.
    const h = buildService({
      ...FULLY_CONFIGURED,
      VIDEO_PREVIEW_ENABLED: undefined,
    });

    expect(() => h.service.onApplicationBootstrap()).not.toThrow();
    expect(h.log).toHaveBeenCalledWith(
      expect.stringContaining('config.readiness_ok'),
    );
  });
});
