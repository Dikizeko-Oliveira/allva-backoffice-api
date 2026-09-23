import {
  Injectable,
  NestMiddleware,
  UnauthorizedException,
} from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  JwtServiceInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';

@Injectable()
export class AuthMiddleware implements NestMiddleware {
  constructor(
    private readonly jwt: JwtServiceInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly sessionsRepository: SessionsRepositoryInterface,
  ) {}

  async use(req: Request & { user?: any }, _: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return next();
    }

    const [, token] = authHeader.split(' ');

    if (!token) {
      return next();
    }

    try {
      const payload = await this.jwt.verify(token);

      const sessionId = payload.sid as string;
      if (!sessionId) {
        throw new UnauthorizedException({
          code: 'INVALID_TOKEN',
          message: 'Session not found in token',
        });
      }

      const session = await this.sessionsRepository.findById(sessionId);

      if (!session || !session.isActive()) {
        throw new UnauthorizedException({
          code: 'SESSION_REVOKED',
          message: 'Session has been revoked',
        });
      }

      const user = await this.accountsRepository.findById(
        payload.sub as string,
      );

      if (!user) {
        throw new UnauthorizedException({
          code: 'ACCESS_DENIED',
          message: 'User does not have permission',
        });
      }

      if (user.isPlatformSuspended()) {
        throw new UnauthorizedException({
          code: 'ACCOUNT_SUSPENDED',
          message: 'Account access has been suspended',
        });
      }

      req.user = {
        id: user.id,
        sessionId: session.id,
        email: user.email,
        // Já carregado acima: é o que o `EntitlementGuard` lê para recusar
        // conta de plataforma no produto do cliente sem uma segunda consulta.
        role: user.role,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }
      req.user = null;
    }

    next();
  }
}
