import { Injectable, UnauthorizedException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

@Injectable()
export class AnthropicClient {
  private client: Anthropic | null = null;

  constructor(private readonly env: EnvService) {}

  /**
   * Anthropic is an optional provider: without a key the router simply drops it
   * from the route. Building the SDK lazily keeps a missing key from taking the
   * whole application down at boot.
   */
  isConfigured(): boolean {
    return Boolean(this.apiKey());
  }

  async createMessage(input: {
    model: string;
    system: string;
    prompt: string;
    maxTokens?: number;
    temperature?: number;
  }): Promise<{
    text: string;
    inputTokens: number | null;
    outputTokens: number | null;
  }> {
    const response = await this.resolveClient().messages.create({
      model: input.model,
      system: input.system,
      max_tokens: input.maxTokens ?? 1500,
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      messages: [
        {
          role: 'user',
          content: input.prompt,
        },
      ],
    });

    const text = response.content.find((item) => item.type === 'text')?.text;

    if (!text) {
      throw new Error('Anthropic returned an empty response');
    }

    return {
      text,
      inputTokens: response.usage?.input_tokens ?? null,
      outputTokens: response.usage?.output_tokens ?? null,
    };
  }

  private resolveClient(): Anthropic {
    if (this.client) return this.client;

    const apiKey = this.apiKey();

    if (!apiKey) {
      throw new UnauthorizedException('Anthropic API key is not configured');
    }

    this.client = new Anthropic({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL?.trim() || undefined,
      timeout: Number(this.env.get('AI_REQUEST_TIMEOUT_MS')),
      // Retry and fallback belong to the orchestrator; SDK-level retries would
      // multiply on top of it and swallow the Retry-After hints it relies on.
      maxRetries: 0,
    });

    return this.client;
  }

  private apiKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY?.trim() || undefined;
  }
}
