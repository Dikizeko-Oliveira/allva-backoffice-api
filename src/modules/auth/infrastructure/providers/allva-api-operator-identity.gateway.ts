import { HttpException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Operator } from 'src/modules/auth/domain/entities';
import {
  OperatorIdentityGatewayInterface,
  OperatorIdentityResult,
} from 'src/modules/auth/domain/ports';
import { AllvaApiClient } from 'src/shared/infrastructure/allva-api/allva-api.client';
import { EnvService } from 'src/shared/infrastructure/config/env.service';

type AuthMeResponse = {
  account?: { id?: string; name?: string; email?: string };
  platformRole?: string | null;
  platformPermissions?: string[];
};

type CachedResult = Extract<
  OperatorIdentityResult,
  { status: 'OPERATOR' } | { status: 'NOT_OPERATOR' }
>;

type CacheEntry = { expiresAt: number; result: CachedResult };

/** Timeout de `docs/backoffice-api.md` §2: o hub não espera mais que isso. */
const INTROSPECTION_TIMEOUT_MS = 2_000;
/** Acima disto, as entradas vencidas são varridas antes de gravar a próxima. */
const CACHE_SWEEP_THRESHOLD = 1_000;

/**
 * Introspecção via `GET /api/v1/auth/me` do `allva-api`, com cache curto.
 *
 * Validar o JWT localmente seria mais rápido, mas perderia as duas coisas que
 * só o `allva-api` sabe: sessão revogada e troca de papel. O cache de no máximo
 * 60s é o meio-termo documentado.
 *
 * Só se cacheia resposta **conclusiva** (operador ou cliente). Token recusado
 * e dependência fora não entram: o primeiro pode ser um login novo daqui a um
 * segundo, e o segundo não diz nada sobre o token.
 *
 * A chave é o hash do token, não o token — o mapa em memória não precisa
 * guardar credencial.
 */
@Injectable()
export class AllvaApiOperatorIdentityGateway extends OperatorIdentityGatewayInterface {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;

  constructor(
    private readonly allvaApi: AllvaApiClient,
    env: EnvService,
  ) {
    super();
    this.ttlMs = env.get('OPERATOR_INTROSPECTION_CACHE_MS');
  }

  async introspect(accessToken: string): Promise<OperatorIdentityResult> {
    const key = createHash('sha256').update(accessToken).digest('hex');
    const now = Date.now();
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > now) return cached.result;

    let response: AuthMeResponse;

    try {
      response = await this.allvaApi.request<AuthMeResponse>(
        '/api/v1/auth/me',
        { token: accessToken, timeoutMs: INTROSPECTION_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 401) {
        return { status: 'UNAUTHENTICATED' };
      }

      return { status: 'UNAVAILABLE' };
    }

    const result = toResult(response, accessToken);
    this.remember(key, result, now);
    return result;
  }

  private remember(key: string, result: CachedResult, now: number): void {
    if (this.ttlMs <= 0) return;

    if (this.cache.size >= CACHE_SWEEP_THRESHOLD) {
      for (const [entryKey, entry] of this.cache) {
        if (entry.expiresAt <= now) this.cache.delete(entryKey);
      }
    }

    this.cache.set(key, { result, expiresAt: now + this.ttlMs });
  }
}

/**
 * Resposta incompleta conta como "não é operador": sem `id`, `email`, papel e
 * a lista de permissões, não há com o que autorizar — e fechar na dúvida é a
 * regra.
 */
function toResult(response: AuthMeResponse, accessToken: string): CachedResult {
  const { account, platformRole, platformPermissions } = response;

  if (
    !account?.id ||
    !account.email ||
    !platformRole ||
    !Array.isArray(platformPermissions)
  ) {
    return { status: 'NOT_OPERATOR' };
  }

  return {
    status: 'OPERATOR',
    operator: Operator.restore({
      id: account.id,
      name: account.name ?? account.email,
      email: account.email,
      platformRole,
      permissions: platformPermissions,
      accessToken,
    }),
  };
}
