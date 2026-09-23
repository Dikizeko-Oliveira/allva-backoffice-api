import { ForbiddenException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { assertCustomerAccount } from 'src/modules/accounts/application/platform-authorization';
import { Account } from 'src/modules/accounts/domain/entities/account.entity';
import { isPlatformRole } from 'src/modules/accounts/domain/platform-rbac';
import { LoginWithPasswordOutputDto } from 'src/modules/auth/application/dtos';
import { Session } from 'src/modules/auth/domain/entities/session.entity';
import { SessionAudience } from 'src/modules/auth/domain/session-audience';
import {
  JwtServiceInterface,
  PasswordHasherInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';

type IssueAuthSessionInput = {
  account: Account;
  ipAddress?: string;
  userAgent?: string;
  /** Ausente = sem checagem de front (compatibilidade). */
  audience?: SessionAudience;
};

@Injectable()
export class IssueAuthSessionUseCase {
  constructor(
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly jwtService: JwtServiceInterface,
    private readonly sessionsRepository: SessionsRepositoryInterface,
  ) {}

  async execute(
    input: IssueAuthSessionInput,
  ): Promise<LoginWithPasswordOutputDto> {
    if (input.account.isPlatformSuspended()) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Account access has been suspended',
      });
    }

    if (input.audience) {
      this.assertAudience(input.account, input.audience);
    }

    const refreshToken = randomBytes(64).toString('hex');
    const refreshTokenHash = await this.passwordHasher.hash(refreshToken);

    const session = Session.create({
      accountId: input.account.id,
      refreshTokenHash,
      expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 30),
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    await this.sessionsRepository.save(session);

    const accessToken = await this.jwtService.sign({
      sub: input.account.id,
      sid: session.id,
      email: input.account.email,
      name: input.account.name,
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  /**
   * Chega aqui só quem já provou a credencial, então um código distinto não
   * revela nada que o atacante com a senha certa já não saiba — e o front
   * precisa dele para dizer "esta conta é do outro painel".
   */
  private assertAudience(account: Account, audience: SessionAudience): void {
    if (audience === 'app') {
      assertCustomerAccount(account);
      return;
    }

    if (!isPlatformRole(account.role)) {
      throw new ForbiddenException({
        code: 'BACKOFFICE_ACCESS_DENIED',
        message: 'This account does not have access to the backoffice',
      });
    }
  }
}
