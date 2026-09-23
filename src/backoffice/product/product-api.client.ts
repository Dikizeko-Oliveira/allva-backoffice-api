import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';

type RequestOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  timeoutMs?: number;
};

@Injectable()
export class ProductApiClient {
  private readonly baseUrl = (
    process.env.ALLVA_API_URL ??
    process.env.PRODUCT_API_URL ??
    'http://localhost:8080'
  ).replace(/\/$/, '');

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'allva-backoffice-api/1.0',
    };

    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.body !== undefined)
      headers['Content-Type'] = 'application/json';

    let response: Response;

    try {
      response = await fetch(url, {
        method: options.method ?? 'GET',
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? 5_000),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'PRODUCT_API_UNAVAILABLE',
        message: 'Could not reach allva-api',
      });
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({
        code: response.status === 404 ? 'NOT_FOUND' : 'PRODUCT_API_ERROR',
        message: response.statusText,
      }));
      throw new HttpException(payload, response.status);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => undefined)) as T;
  }

  private buildUrl(path: string, query: RequestOptions['query'] = {}): string {
    const pathname = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${pathname}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}
