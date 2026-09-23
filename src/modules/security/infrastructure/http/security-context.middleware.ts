import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Response } from 'express';
import {
  extractClientContext,
  RequestWithClientContext,
} from './client-context';

/**
 * Global middleware that resolves the caller's IP/user-agent once per request
 * and attaches it as `req.clientContext`. Runs ahead of AuthMiddleware so every
 * downstream handler (and the security audit pipeline) shares one consistent
 * view of the client without re-parsing headers.
 */
@Injectable()
export class SecurityContextMiddleware implements NestMiddleware {
  use(req: RequestWithClientContext, _res: Response, next: NextFunction) {
    req.clientContext = extractClientContext(req);
    next();
  }
}
