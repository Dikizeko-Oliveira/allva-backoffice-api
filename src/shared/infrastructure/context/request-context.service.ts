import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContextStore = {
  /** The organization selected for this request via X-Organization-Id. */
  organizationId?: string;
  /**
   * Correlation id for this request (architecture §5.6.2). Established by
   * `CorrelationIdMiddleware`, honouring an inbound `X-Correlation-Id`. It is
   * what makes "everything that happened because of that click" a query instead
   * of a manual timestamp correlation.
   */
  correlationId?: string;
};

/**
 * Per-request context propagated with AsyncLocalStorage.
 *
 * It lets code deep in the call chain (e.g. OwnerScopeResolverService, invoked
 * from application use cases that never see the HTTP request) read the selected
 * organization without threading it through every method signature.
 *
 * Outside an HTTP request — background workers, schedulers, queue processors —
 * there is no active store, so readers fall back to their default behavior.
 * That graceful degradation is intentional: the store being empty must never
 * be an error.
 */
@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<RequestContextStore>();

  /** Runs `callback` with `store` as the active per-request context. */
  run<T>(store: RequestContextStore, callback: () => T): T {
    return this.storage.run(store, callback);
  }

  /**
   * Runs `callback` with `store` merged onto the active context.
   *
   * A plain `run` replaces the store, so a later middleware publishing the
   * organization would drop the correlation id the earlier one established —
   * and the chain would break at the first hop, silently.
   */
  runMerging<T>(store: RequestContextStore, callback: () => T): T {
    return this.storage.run({ ...this.storage.getStore(), ...store }, callback);
  }

  /** The selected organization id, or undefined when outside a request. */
  getOrganizationId(): string | undefined {
    return this.storage.getStore()?.organizationId;
  }

  /** The correlation id of the current request, or undefined outside one. */
  getCorrelationId(): string | undefined {
    return this.storage.getStore()?.correlationId;
  }
}
