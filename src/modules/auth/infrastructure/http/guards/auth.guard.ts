import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';

const PUBLIC_DOCUMENTATION_PATHS = ['/docs', '/docs-json', '/scalar'];

function isPublicDocumentationPath(path: string) {
  return PUBLIC_DOCUMENTATION_PATHS.some(
    (publicPath) => path === publicPath || path.startsWith(`${publicPath}/`),
  );
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: any }>();

    if (isPublicDocumentationPath(request.path)) {
      return true;
    }

    if (!request.user) {
      throw new UnauthorizedException('Unauthorized');
    }

    return true;
  }
}
