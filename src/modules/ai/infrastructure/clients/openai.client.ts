import { Injectable, UnauthorizedException } from '@nestjs/common';
import OpenAI from 'openai';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

@Injectable()
export class OpenAIClient {
  private _client: OpenAI | null = null;

  constructor(private readonly env: EnvService) {}

  /** Whether a request can be attempted at all. Used by the router to skip a
   *  provider that has no credential instead of failing the whole route. */
  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  /**
   * Resolved lazily, and with an explicit key check (PLAN.md D-1).
   *
   * `OPENAI_API_KEY` is optional in the schema, so the absent case has to produce a
   * diagnosable error rather than the SDK's own "environment variable is missing"
   * throw from deep inside a request. Same shape as `AnthropicClient`, which Sprint 5
   * had to make lazy for exactly this reason.
   */
  get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.apiKey();

      if (!apiKey) {
        throw new UnauthorizedException('OpenAI API key is not configured');
      }

      this._client = new OpenAI({
        apiKey,
        timeout: Number(this.env.get('AI_REQUEST_TIMEOUT_MS')),
        // Retry and fallback belong to the orchestrator; SDK-level retries would
        // multiply on top of it and swallow the Retry-After hints it relies on.
        maxRetries: 0,
      });
    }

    return this._client;
  }

  private apiKey(): string | undefined {
    return this.env.get('OPENAI_API_KEY')?.trim() || undefined;
  }
}
