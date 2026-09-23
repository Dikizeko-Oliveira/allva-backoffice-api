import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { OrganizationContext } from 'src/modules/organizations/application/organization-context.resolver';
import { RequestWithOrganization } from 'src/modules/organizations/infrastructure/http/middlewares/organization-context.middleware';

export const CurrentOrganization = createParamDecorator(
  (_, ctx: ExecutionContext): OrganizationContext | undefined => {
    const request = ctx.switchToHttp().getRequest<RequestWithOrganization>();
    return request.organizationContext;
  },
);
