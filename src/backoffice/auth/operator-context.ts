import { Request } from 'express';

export type PlatformPermission = string;

export type OperatorContext = {
  id: string;
  name: string;
  email: string;
  platformRole: string;
  platformPermissions: PlatformPermission[];
  token: string;
};

export type OperatorRequest = Request & {
  operator?: OperatorContext;
  user?: { id: string; email: string };
};
