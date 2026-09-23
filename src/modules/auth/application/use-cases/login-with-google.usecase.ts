import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { assertCustomerAccount } from 'src/modules/accounts/application/platform-authorization';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  LoginWithGoogleInputDto,
  LoginWithPasswordOutputDto,
} from 'src/modules/auth/application/dtos';
import { AccountProviderIdentity } from 'src/modules/auth/domain/entities';
import {
  AccountProviderIdentitiesRepositoryInterface,
  GoogleIdentityVerifierInterface,
} from 'src/modules/auth/domain/ports';
import { IssueAuthSessionUseCase } from 'src/modules/auth/application/use-cases/issue-auth-session.usecase';

@Injectable()
export class LoginWithGoogleUseCase {
  constructor(
    private readonly googleIdentityVerifier: GoogleIdentityVerifierInterface,
    private readonly accountProviderIdentitiesRepository: AccountProviderIdentitiesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly issueAuthSessionUseCase: IssueAuthSessionUseCase,
  ) {}

  async execute(
    input: LoginWithGoogleInputDto,
  ): Promise<LoginWithPasswordOutputDto> {
    const googleIdentity = await this.googleIdentityVerifier.verifyIdToken(
      input.idToken,
    );
    const account = await this.resolveAccount(googleIdentity);

    return this.issueAuthSessionUseCase.execute({
      account: account,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      // Porta de cadastro do produto do cliente; o backoffice não a oferece.
      audience: 'app',
    });
  }

  private async resolveAccount(googleIdentity: {
    subject: string;
    email: string;
    name: string;
  }) {
    const linkedIdentity =
      await this.accountProviderIdentitiesRepository.findByProviderSubject(
        'google',
        googleIdentity.subject,
      );

    if (linkedIdentity) {
      const account = await this.accountsRepository.findById(
        linkedIdentity.accountId,
      );

      if (!account) {
        throw new InternalServerErrorException({
          code: 'GOOGLE_ACCOUNT_LINK_INVALID',
          message: 'Google account link is invalid',
        });
      }

      return account;
    }

    const account = await this.accountsRepository.findByEmail(
      googleIdentity.email,
    );

    if (!account) {
      throw new BadRequestException({
        code: 'ACCOUNT_REGISTRATION_REQUIRED',
        message:
          'Google login requires an existing account created through the signup flow',
      });
    }

    // Antes do vínculo: sem isto a identidade federada ficava presa à conta
    // de operador mesmo com a sessão recusada logo em seguida.
    assertCustomerAccount(account);

    await this.linkGoogleIdentity(account.id, googleIdentity);

    return account;
  }

  private async linkGoogleIdentity(
    accountId: string,
    googleIdentity: {
      subject: string;
      email: string;
    },
  ) {
    try {
      await this.accountProviderIdentitiesRepository.save(
        AccountProviderIdentity.create({
          accountId,
          provider: 'google',
          providerSubject: googleIdentity.subject,
          email: googleIdentity.email,
        }),
      );
    } catch {
      const linkedIdentity =
        await this.accountProviderIdentitiesRepository.findByProviderSubject(
          'google',
          googleIdentity.subject,
        );

      if (linkedIdentity?.accountId !== accountId) {
        throw new UnauthorizedException({
          code: 'GOOGLE_ACCOUNT_ALREADY_LINKED',
          message: 'Google account is already linked to another user',
        });
      }
    }
  }
}
