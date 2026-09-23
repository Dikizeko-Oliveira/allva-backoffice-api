import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { WorkspaceContext } from 'src/modules/organizations/application/workspace-context';
import { RequestWithOrganization } from 'src/modules/organizations/infrastructure/http/middlewares/organization-context.middleware';

/**
 * Injects the server-resolved WorkspaceContext (ORGANIZATION or NO_ORGANIZATION) for
 * the current request. Undefined only on unauthenticated requests.
 */
export const CurrentWorkspace = createParamDecorator(
  (_, ctx: ExecutionContext): WorkspaceContext | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithOrganization>();
    return request.workspaceContext;
  },
);
