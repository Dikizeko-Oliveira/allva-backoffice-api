import { SetMetadata } from '@nestjs/common';
import { Permission } from 'src/modules/organizations/domain/rbac';

export const ORG_PERMISSIONS_METADATA = 'org:requiredPermissions';

export const RequirePermissions = (...permissions: Permission[]) =>
  SetMetadata(ORG_PERMISSIONS_METADATA, permissions);
