import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticateOperatorUseCase } from 'src/modules/auth/application/use-cases';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { OperatorRequest } from '../operator-request';

const PUBLIC_DOCUMENTATION_PATHS = ['/docs', '/docs-json', '/scalar'];

function isPublicDocumentationPath(path: string) {
  return PUBLIC_DOCUMENTATION_PATHS.some(
    (publicPath) => path === publicPath || path.startsWith(`${publicPath}/`),
  );
}

/**
 * Guard global: toda rota exige operador identificado, salvo `@Public()`.
 *
 * Só **autenticação**. A autorização (qual permissão a ação exige) mora no use
 * case, via `assertPlatformPermission` — este guard nunca decide por
 * permissão.
 */
@Injectable()
export class OperatorAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authenticateOperator: AuthenticateOperatorUseCase,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<OperatorRequest>();

    if (isPublicDocumentationPath(request.path)) return true;

    const [scheme, token] = (request.headers.authorization ?? '').split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
    }

    request.operator = await this.authenticateOperator.execute(token);

    return true;
  }
}
