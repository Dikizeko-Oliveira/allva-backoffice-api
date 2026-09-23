import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ProductApiClient } from '../product/product-api.client';
import { OperatorContext } from './operator-context';

type AuthMeResponse = {
  account?: { id?: string; name?: string; email?: string };
  platformRole?: string | null;
  platformPermissions?: string[];
};

type CacheEntry = {
  expiresAt: number;
  operator: OperatorContext | null;
};

@Injectable()
export class OperatorIntrospectionService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs = Math.min(
    Number(process.env.OPERATOR_INTROSPECTION_CACHE_MS ?? 60_000),
    60_000,
  );

  constructor(private readonly productApi: ProductApiClient) {}

  async introspect(token: string): Promise<OperatorContext | null> {
    const cached = this.cache.get(token);
    if (cached && cached.expiresAt > Date.now()) return cached.operator;

    let response: AuthMeResponse;

    try {
      response = await this.productApi.request<AuthMeResponse>(
        '/api/v1/auth/me',
        { token, timeoutMs: 2_000 },
      );
    } catch (error) {
      if ((error as { getStatus?: () => number }).getStatus?.() === 401) {
        throw error;
      }

      throw new ServiceUnavailableException({
        code: 'IDENTITY_INTROSPECTION_FAILED',
        message: 'Could not confirm operator identity',
      });
    }

    const account = response.account;
    const permissions = response.platformPermissions;

    const operator =
      account?.id &&
      account.email &&
      response.platformRole &&
      Array.isArray(permissions)
        ? {
            id: account.id,
            name: account.name ?? account.email,
            email: account.email,
            platformRole: response.platformRole,
            platformPermissions: permissions,
            token,
          }
        : null;

    this.cache.set(token, {
      operator,
      expiresAt: Date.now() + this.ttlMs,
    });

    return operator;
  }
}
