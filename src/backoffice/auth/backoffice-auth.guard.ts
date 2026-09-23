import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { OperatorIntrospectionService } from './operator-introspection.service';
import { OperatorRequest } from './operator-context';

const PUBLIC_PATHS = ['/docs', '/docs-json', '/scalar', '/health'];

function isPublicPath(path: string): boolean {
  return PUBLIC_PATHS.some(
    (publicPath) => path === publicPath || path.startsWith(`${publicPath}/`),
  );
}

@Injectable()
export class BackofficeAuthGuard implements CanActivate {
  constructor(private readonly introspection: OperatorIntrospectionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const path = (request as unknown as { path?: string }).path ?? '';

    if (isPublicPath(path)) return true;

    const [scheme, token] = String(
      (request as unknown as { headers?: Record<string, string> }).headers
        ?.authorization ?? '',
    ).split(' ');

    if (scheme !== 'Bearer' || !token) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Unauthorized',
      });
    }

    const operator = await this.introspection.introspect(token);

    if (!operator) {
      throw new ForbiddenException({
        code: 'ACCOUNT_NOT_AUTHORIZED',
        message: 'Account not authorized: requires platform account',
        details: { permission: 'platform' },
      });
    }

    request.operator = operator;
    request.user = { id: operator.id, email: operator.email };

    return true;
  }
}
