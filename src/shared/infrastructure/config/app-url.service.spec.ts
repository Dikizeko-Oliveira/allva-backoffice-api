import { AppUrlService } from './app-url.service';

function buildService(frontendUrl: string, apiUrl?: string) {
  const env = {
    get: jest.fn((key: string) =>
      key === 'API_PUBLIC_URL' ? apiUrl : frontendUrl,
    ),
  };

  return new AppUrlService(env as never);
}

describe('AppUrlService', () => {
  it('reads FRONTEND_URL, not the old undeclared APP_URL', () => {
    const env = { get: jest.fn().mockReturnValue('https://app.example.com') };

    void new AppUrlService(env as never).baseUrl;

    expect(env.get).toHaveBeenCalledWith('FRONTEND_URL');
  });

  it('strips trailing slashes so concatenation never doubles them', () => {
    expect(buildService('https://app.example.com///').baseUrl).toBe(
      'https://app.example.com',
    );
  });

  it('joins a path with or without a leading slash', () => {
    const service = buildService('https://app.example.com/');

    expect(service.pathTo('/auth/verify-email?token=abc')).toBe(
      'https://app.example.com/auth/verify-email?token=abc',
    );
    expect(service.pathTo('auth/verify-email?token=abc')).toBe(
      'https://app.example.com/auth/verify-email?token=abc',
    );
  });

  it('follows the environment instead of falling back to production', () => {
    // The regression this class exists to prevent: alert and daily-summary mail
    // used an undeclared APP_URL whose fallback was the production host, so a
    // staging deploy sent links pointing at production.
    expect(buildService('http://localhost:3000').baseUrl).toBe(
      'http://localhost:3000',
    );
  });

  describe('apiBaseUrl / apiPathTo', () => {
    it('monta a URL da própria API quando ela foi declarada', () => {
      const service = buildService(
        'https://app.example.com',
        'https://api.example.com/',
      );

      expect(service.apiBaseUrl).toBe('https://api.example.com');
      expect(service.apiPathTo('/api/v1/reports/1/file?token=x')).toBe(
        'https://api.example.com/api/v1/reports/1/file?token=x',
      );
      expect(service.apiPathTo('api/v1/reports/1/file')).toBe(
        'https://api.example.com/api/v1/reports/1/file',
      );
    });

    /**
     * O mesmo defeito que originou esta classe, do outro lado: adivinhar o host
     * da API é como um e-mail de produção acaba com link para `localhost`. Sem
     * a variável, quem chama decide o destino alternativo.
     */
    it.each([undefined, '', '   '])(
      'devolve undefined em vez de adivinhar (%p)',
      (value) => {
        const service = buildService('https://app.example.com', value);

        expect(service.apiBaseUrl).toBeUndefined();
        expect(service.apiPathTo('api/v1/reports/1/file')).toBeUndefined();
      },
    );
  });
});
