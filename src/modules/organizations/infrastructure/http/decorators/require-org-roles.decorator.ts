import { SetMetadata } from '@nestjs/common';
import { OrganizationRole } from 'src/modules/organizations/domain/rbac';

export const ORG_ROLES_METADATA = 'org:requiredRoles';

export const RequireOrgRoles = (...roles: OrganizationRole[]) =>
  SetMetadata(ORG_ROLES_METADATA, roles);
