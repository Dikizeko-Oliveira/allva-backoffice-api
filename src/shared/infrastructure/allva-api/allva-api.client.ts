import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { CORRELATION_ID_HEADER } from 'src/shared/infrastructure/context/correlation-id.middleware';
import { RequestContextService } from 'src/shared/infrastructure/context/request-context.service';

export type AllvaApiQuery = Record<
  string,
  string | number | boolean | null | undefined
>;

export type AllvaApiRequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Bearer do operador, repassado. O backoffice-api não tem credencial própria. */
  token?: string;
  body?: unknown;
  query?: AllvaApiQuery;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * O transporte HTTP até o `allva-api`.
 *
 * Só transporte: nenhum módulo o injeta direto num use case. Cada módulo
 * declara em `domain/ports` o que precisa do produto (um gateway) e o
 * implementa em `infrastructure/providers` sobre este cliente — é o que deixa
 * o use case testável sem rede e mantém o formato das respostas do produto
 * fora da aplicação.
 *
 * ## Erros
 *
 * - Rede fora ou timeout ⇒ `503 PRODUCT_API_UNAVAILABLE`. O operador não fez
 *   nada errado; quem falhou foi a dependência.
 * - Resposta não-2xx ⇒ o status e o corpo do `allva-api` passam adiante. Um
 *   `403 ACCOUNT_NOT_AUTHORIZED` de lá é a mesma recusa aqui, com o mesmo
 *   `details.permission` que a tela usa.
 */
@Injectable()
export class AllvaApiClient {
  private readonly baseUrl: string;

  constructor(
    env: EnvService,
    private readonly requestContext: RequestContextService,
  ) {
    this.baseUrl = env.get('ALLVA_API_URL').replace(/\/$/, '');
  }

  async request<T>(
    path: string,
    options: AllvaApiRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'allva-backoffice-api/1.0',
    };

    if (options.token) headers.Authorization = `Bearer ${options.token}`;

    // A mesma correlação atravessa web → backoffice-api → allva-api: sem isso,
    // o log do produto não diz qual clique no backoffice causou a chamada.
    const correlationId = this.requestContext.getCorrelationId();
    if (correlationId) headers[CORRELATION_ID_HEADER] = correlationId;

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let response: Response;

    try {
      response = await fetch(this.buildUrl(path, options.query), {
        method: options.method ?? 'GET',
        headers,
        body:
          options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'PRODUCT_API_UNAVAILABLE',
        message: 'Could not reach allva-api',
      });
    }

    if (!response.ok) {
      const payload: unknown = await response.json().catch(() => ({
        code: response.status === 404 ? 'NOT_FOUND' : 'PRODUCT_API_ERROR',
        message: response.statusText,
      }));
      throw new HttpException(
        payload as Record<string, unknown>,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    return (await response.json().catch(() => undefined)) as T;
  }

  private buildUrl(path: string, query: AllvaApiQuery = {}): string {
    const pathname = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${pathname}`);

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url.toString();
  }
}
