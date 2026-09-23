import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContextStore = {
  /**
   * Correlation id for this request. Established by `CorrelationIdMiddleware`,
   * honouring an inbound `X-Correlation-Id` — it is what ties a click in the
   * backoffice-web to the calls this service makes to `allva-api`.
   */
  correlationId?: string;
};

/**
 * Per-request context propagated with AsyncLocalStorage, so code deep in the
 * call chain can read it without threading it through every signature.
 *
 * Outside an HTTP request there is no active store, and readers fall back to
 * their default behaviour — the store being empty must never be an error.
 */
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContextStore>();

  /** Runs `callback` with `store` as the active per-request context. */
  run<T>(store: RequestContextStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }

  /** The correlation id of the current request, or undefined outside one. */
  getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }
}
