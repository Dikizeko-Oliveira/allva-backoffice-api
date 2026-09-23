import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Operator } from 'src/modules/auth/domain/entities';
import { OperatorIdentityGatewayInterface } from 'src/modules/auth/domain/ports';

/**
 * Transforma um bearer token em operador — ou recusa.
 *
 * **Fecha na dúvida** (`docs/backoffice-api.md` §1.4, regra 4): conta de
 * cliente é `403`, token inválido é `401` e `allva-api` indisponível é `503`.
 * Nunca "liberar enquanto o allva-api volta".
 */
@Injectable()
export class AuthenticateOperatorUseCase {
  constructor(private readonly identity: OperatorIdentityGatewayInterface) {}

  async execute(accessToken: string): Promise<Operator> {
    const result = await this.identity.introspect(accessToken);

    switch (result.status) {
      case 'OPERATOR':
        return result.operator;

      case 'NOT_OPERATOR':
        throw new ForbiddenException({
          code: 'ACCOUNT_NOT_AUTHORIZED',
          message: 'Account not authorized: requires platform account',
          details: { permission: 'platform' },
        });

      case 'UNAUTHENTICATED':
        throw new UnauthorizedException({
          code: 'UNAUTHORIZED',
          message: 'Unauthorized',
        });

      case 'UNAVAILABLE':
        throw new ServiceUnavailableException({
          code: 'IDENTITY_INTROSPECTION_FAILED',
          message: 'Could not confirm operator identity',
        });
    }
  }
}
