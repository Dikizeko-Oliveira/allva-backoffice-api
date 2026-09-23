import { Injectable, Logger } from '@nestjs/common';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { AIErrorCode, ClassifiedAIError } from './ai-error-classifier.service';
import { ModelCandidate } from './ai-task.types';

type Cooldown = {
  until: number;
  code: AIErrorCode;
};

/** Never park a provider for longer than this, however bad the hint was. */
const MAX_COOLDOWN_MS = 5 * 60_000;
/** A rejected key will not start working within seconds — park it for longer. */
const AUTH_COOLDOWN_MS = 5 * 60_000;

/**
 * Multipliers applied to the configured base cooldown. Failures that say
 * something about the provider's health park it; failures caused by our own
 * payload or by an unparseable answer do not — those would repeat on every
 * provider and parking would only shrink the route for no reason.
 */
const COOLDOWN_FACTOR: Partial<Record<AIErrorCode, number>> = {
  rate_limit: 1,
  capacity: 1,
  server_error: 1,
  timeout: 0.5,
  network: 0.5,
};

/**
 * Short-lived memory of which provider/model pairs are currently unhealthy, so a
 * saturated provider is skipped outright instead of costing every request a full
 * round of retries before the fallback kicks in.
 *
 * State is per-process and deliberately in-memory: it is a latency optimisation,
 * not a correctness mechanism, and a stale entry costs at most one skipped
 * candidate.
 */
@Injectable()
export class ProviderHealthRegistry {
  private readonly logger = new Logger(ProviderHealthRegistry.name);
  private readonly cooldowns = new Map<string, Cooldown>();

  constructor(private readonly env: EnvService) {}

  /** Convenience predicate over `cooldownRemainingMs`. Used by the tests that
   *  assert cooldown behaviour; the orchestrator needs the remaining time so it
   *  can log how long a candidate is parked for. */
  isAvailable(candidate: ModelCandidate): boolean {
    return this.cooldownRemainingMs(candidate) === 0;
  }

  cooldownRemainingMs(candidate: ModelCandidate): number {
    const key = this.keyOf(candidate);
    const cooldown = this.cooldowns.get(key);

    if (!cooldown) return 0;

    const remaining = cooldown.until - Date.now();

    if (remaining <= 0) {
      this.cooldowns.delete(key);
      return 0;
    }

    return remaining;
  }

  reportSuccess(candidate: ModelCandidate): void {
    this.cooldowns.delete(this.keyOf(candidate));
  }

  reportFailure(candidate: ModelCandidate, error: ClassifiedAIError): void {
    const duration = this.cooldownFor(error);

    if (duration <= 0) return;

    const key = this.keyOf(candidate);
    const until = Date.now() + duration;
    const current = this.cooldowns.get(key);

    // Keep whichever cooldown ends later: a 60s Retry-After must not be cut
    // short by a subsequent generic failure.
    if (current && current.until >= until) return;

    this.cooldowns.set(key, { until, code: error.code });
    this.logger.warn(
      `Cooling down ${key} for ${duration}ms after ${error.code}`,
    );
  }

  /** Test seam — the process-wide map would otherwise leak across cases. */
  reset(): void {
    this.cooldowns.clear();
  }

  private cooldownFor(error: ClassifiedAIError): number {
    if (error.code === 'auth') return AUTH_COOLDOWN_MS;

    const factor = COOLDOWN_FACTOR[error.code];

    if (factor === undefined) return 0;

    // A provider that asked for a specific wait gets exactly that.
    const duration =
      error.retryAfterMs ??
      Number(this.env.get('AI_PROVIDER_COOLDOWN_MS')) * factor;

    return Math.min(Math.round(duration), MAX_COOLDOWN_MS);
  }

  private keyOf(candidate: ModelCandidate): string {
    return `${candidate.provider}/${candidate.model}`;
  }
}
