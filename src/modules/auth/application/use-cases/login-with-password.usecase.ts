import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { LoginWithPasswordInputDto, LoginWithPasswordOutputDto } from '../dtos';
import { PasswordHasherInterface } from 'src/modules/auth/domain/ports';
import { IssueAuthSessionUseCase } from 'src/modules/auth/application/use-cases/issue-auth-session.usecase';
import {
  BruteForceProtectionService,
  SuspiciousActivityService,
} from 'src/modules/security/application';

@Injectable()
export class LoginWithPasswordUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly issueAuthSessionUseCase: IssueAuthSessionUseCase,
    private readonly bruteForce: BruteForceProtectionService,
    private readonly suspiciousActivity: SuspiciousActivityService,
  ) {}

  async execute(
    input: LoginWithPasswordInputDto,
  ): Promise<LoginWithPasswordOutputDto> {
    const bruteForceKey = {
      scope: 'login' as const,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      accountKey: input.email,
    };

    // Progressive lockout check before any credential work.
    await this.bruteForce.assertNotLocked(bruteForceKey);

    const account = await this.accountsRepository.findByEmail(input.email);

    // Same generic failure for unknown email and bad password (no enumeration).
    if (!account) {
      await this.bruteForce.registerFailure(bruteForceKey);
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    const passwordMatches = await this.passwordHasher.compare(
      input.password,
      account.passwordHash,
    );

    if (!passwordMatches) {
      await this.bruteForce.registerFailure({
        ...bruteForceKey,
        accountId: account.id,
      });
      throw new UnauthorizedException({
        code: 'INVALID_CREDENTIALS',
        message: 'Invalid email or password',
      });
    }

    // Credentials are valid from here on, so a distinct error is safe (it
    // reveals nothing an attacker with the right password doesn't already know)
    // and the client needs it to route the user to the "confirm your email" flow.
    if (!account.emailVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_NOT_VERIFIED',
        message: 'Confirm your email address to access your account',
        email: account.email,
      });
    }

    if (account.isPlatformSuspended()) {
      throw new ForbiddenException({
        code: 'ACCOUNT_SUSPENDED',
        message: 'Account access has been suspended',
      });
    }

    await this.suspiciousActivity.evaluate({
      accountId: account.id,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    });

    return this.issueAuthSessionUseCase.execute({
      account,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      audience: input.audience,
    });
  }
}
