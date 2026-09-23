import { SetMetadata } from '@nestjs/common';

export const AUTHENTICATED_ONLY_METADATA = 'access:authenticatedOnly';

export const AuthenticatedOnly = () =>
  SetMetadata(AUTHENTICATED_ONLY_METADATA, true);
