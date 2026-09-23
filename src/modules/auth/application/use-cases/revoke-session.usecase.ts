import { Injectable, NotFoundException } from '@nestjs/common';
import { RevokeSessionInputDto, RevokeSessionOutputDto } from '../dtos';
import { SessionsRepositoryInterface } from 'src/modules/auth/domain/ports';
import { SecurityAuditLogService } from 'src/modules/security/application';

type RevokeSessionContext = {
  ipAddress?: string;
  userAgent?: string;
};

@Injectable()
export class RevokeSessionUseCase {
  constructor(
    private readonly sessionsRepository: SessionsRepositoryInterface,
    private readonly securityAuditLog: SecurityAuditLogService,
  ) {}

  async execute(
    input: RevokeSessionInputDto,
    context: RevokeSessionContext = {},
  ): Promise<RevokeSessionOutputDto> {
    const session = await this.sessionsRepository.findById(input.sessionId);

    if (!session) {
      throw new NotFoundException({
        code: 'SESSION_NOT_FOUND',
        message: 'Session not found',
      });
    }

    session.revoke();
    await this.sessionsRepository.update(session);

    await this.securityAuditLog.record({
      event: 'session.revoked',
      severity: 'info',
      accountId: session.accountId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: { sessionId: session.id },
    });

    return {};
  }
}
