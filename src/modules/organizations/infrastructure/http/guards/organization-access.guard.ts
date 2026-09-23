import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  OrganizationRole,
  Permission,
} from 'src/modules/organizations/domain/rbac';
import { PermissionResolverService } from 'src/modules/organizations/application/permission-resolver.service';
import { organizationWorkspace } from 'src/modules/organizations/application/workspace-context';
import { ORG_ROLES_METADATA } from 'src/modules/organizations/infrastructure/http/decorators/require-org-roles.decorator';
import { ORG_PERMISSIONS_METADATA } from 'src/modules/organizations/infrastructure/http/decorators/require-permissions.decorator';
import { RequestWithOrganization } from 'src/modules/organizations/infrastructure/http/middlewares/organization-context.middleware';

/**
 * Enforces multi-tenant RBAC for routes annotated with @RequireOrgRoles and/or
 * @RequirePermissions. Every decision is derived from the membership resolved
 * server-side (req.organizationContext) — never from client-supplied role data.
 */
@Injectable()
export class OrganizationAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionResolver: PermissionResolverService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<OrganizationRole[]>(
      ORG_ROLES_METADATA,
      [context.getHandler(), context.getClass()],
    );
    const requiredPermissions = this.reflector.getAllAndOverride<Permission[]>(
      ORG_PERMISSIONS_METADATA,
      [context.getHandler(), context.getClass()],
    );

    // Route opts out of RBAC entirely.
    if (!requiredRoles?.length && !requiredPermissions?.length) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<RequestWithOrganization>();

    if (!request.user?.id) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
      });
    }

    const organizationContext = request.organizationContext;

    if (!organizationContext) {
      throw new ForbiddenException({
        code: 'ORGANIZATION_CONTEXT_REQUIRED',
        message: 'X-Organization-Id header is required for this resource',
      });
    }

    const { role } = organizationContext;

    if (requiredRoles?.length && !requiredRoles.includes(role)) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ORGANIZATION_ROLE',
        message: 'Your role does not allow this action',
      });
    }

    // Permission decisions are delegated to the centralized resolver (built from
    // the server-resolved workspace), so role -> permission logic lives in one
    // place rather than being re-derived in the guard.
    const workspace = organizationWorkspace(organizationContext);

    if (
      requiredPermissions?.length &&
      !requiredPermissions.every((permission) =>
        this.permissionResolver.can(workspace, permission),
      )
    ) {
      throw new ForbiddenException({
        code: 'INSUFFICIENT_ORGANIZATION_PERMISSION',
        message: 'You do not have permission to perform this action',
      });
    }

    return true;
  }
}
