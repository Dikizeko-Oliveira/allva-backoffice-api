import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PLATFORM_PERMISSIONS_KEY } from './require-platform-permissions.decorator';
import { OperatorRequest } from './operator-context';

@Injectable()
export class PlatformPermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required =
      this.reflector.getAllAndOverride<string[]>(PLATFORM_PERMISSIONS_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? [];

    if (required.length === 0) return true;

    const request = context.switchToHttp().getRequest<OperatorRequest>();
    const permissions = new Set(request.operator?.platformPermissions ?? []);
    const missing = required.find((permission) => !permissions.has(permission));

    if (!missing) return true;

    throw new ForbiddenException({
      code: 'ACCOUNT_NOT_AUTHORIZED',
      message: `Account not authorized: requires platform permission "${missing}"`,
      details: { permission: missing },
    });
  }
}
