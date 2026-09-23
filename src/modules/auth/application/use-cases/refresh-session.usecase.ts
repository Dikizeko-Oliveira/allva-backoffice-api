import { Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RefreshSessionInputDto, RefreshSessionOutputDto } from '../dtos';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { Session } from 'src/modules/auth/domain/entities/session.entity';
import {
  JwtServiceInterface,
  PasswordHasherInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { SecurityAuditLogService } from 'src/modules/security/application';

type RefreshContext = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class RefreshSessionUseCase {
  constructor(
    private readonly jwtService: JwtServiceInterface,
    private readonly sessionsRepository: SessionsRepositoryInterface,
    private readonly tokenHasher: PasswordHasherInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly securityAuditLog: SecurityAuditLogService,
  ) {}

  async execute(
    input: RefreshSessionInputDto,
    context: RefreshContext = {},
  ): Promise<RefreshSessionOutputDto> {
    const refreshTokenHash = await this.tokenHasher.hash(input.refreshToken);

    const session =
      await this.sessionsRepository.findByRefreshTokenHash(refreshTokenHash);

    const genericError = new UnauthorizedException({
      code: 'INVALID_REFRESH_TOKEN',
      message: 'Refresh token is invalid or expired',
    });

    if (!session) {
      throw genericError;
    }

    // Replay detection: a token whose session is already revoked means a
    // previously-rotated (and therefore compromised-or-leaked) refresh token is
    // being reused. Treat as a breach — kill every session for the account and
    // record it — but return the same generic error to the caller.
    if (session.revokedAt) {
      await this.securityAuditLog.record({
        event: 'token.replay.detected',
        severity: 'critical',
        accountId: session.accountId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { sessionId: session.id },
      });

      await this.sessionsRepository.revokeAllByAccountId(session.accountId);

      throw genericError;
    }

    if (!session.isActive()) {
      throw genericError;
    }

    session.revoke();
    await this.sessionsRepository.update(session);

    const newRefreshToken = randomBytes(64).toString('hex');
    const newRefreshTokenHash = await this.tokenHasher.hash(newRefreshToken);

    const newSession = Session.create({
      accountId: session.accountId,
      refreshTokenHash: newRefreshTokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
    });

    await this.sessionsRepository.save(newSession);

    const account = await this.accountsRepository.findById(session.accountId);

    if (!account) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account associated with this session no longer exists',
      });
    }

    if (account.isPlatformSuspended()) {
      throw new UnauthorizedException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Account access has been suspended',
      });
    }

    const accessToken = await this.jwtService.sign({
      sub: account.id,
      sid: newSession.id,
      email: account.email,
      name: account.name,
    });

    return {
      accessToken,
      refreshToken: newRefreshToken,
    };
  }
}
