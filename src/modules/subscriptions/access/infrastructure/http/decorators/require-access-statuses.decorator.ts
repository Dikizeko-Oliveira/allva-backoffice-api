import { SetMetadata } from '@nestjs/common';
import { AccessStatus } from 'src/modules/subscriptions/access/domain/access-status';

export const ACCESS_STATUSES_METADATA = 'access:requiredStatuses';

export const RequireAccessStatuses = (...statuses: AccessStatus[]) =>
  SetMetadata(ACCESS_STATUSES_METADATA, statuses);
