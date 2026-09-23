import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Account } from 'src/modules/accounts/domain/entities/account.entity';
import { assertCustomerAccount } from 'src/modules/accounts/application/platform-authorization';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  LoginWithFacebookInputDto,
  LoginWithPasswordOutputDto,
} from 'src/modules/auth/application/dtos';
import { AccountProviderIdentity } from 'src/modules/auth/domain/entities';
import {
  AccountProviderIdentitiesRepositoryInterface,
  FacebookIdentityVerifierInterface,
  PasswordHasherInterface,
} from 'src/modules/auth/domain/ports';
import { AccountOnboardingService } from 'src/modules/accounts/application/services/account-onboarding.service';
import { assertRegistrationEnabled } from 'src/modules/accounts/application/assert-registration-enabled';
import { assertSelectablePlan } from 'src/modules/plans/application/assert-selectable-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { IssueAuthSessionUseCase } from './issue-auth-session.usecase';

@Injectable()
export class LoginWithFacebookUseCase {
  constructor(
    private readonly facebookIdentityVerifier: FacebookIdentityVerifierInterface,
    private readonly accountProviderIdentitiesRepository: AccountProviderIdentitiesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly issueAuthSessionUseCase: IssueAuthSessionUseCase,
    private readonly onboarding: AccountOnboardingService,
    private readonly env: EnvService,
    private readonly plansRepository: PlansRepositoryInterface,
  ) {}

  async execute(
    input: LoginWithFacebookInputDto,
  ): Promise<LoginWithPasswordOutputDto> {
    const facebookIdentity =
      await this.facebookIdentityVerifier.verifyAccessToken(input.accessToken);

    const account = await this.resolveOrCreateAccount(
      facebookIdentity,
      input.selectedPlanId,
    );

    return this.issueAuthSessionUseCase.execute({
      account,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
      // Porta de cadastro do produto do cliente; o backoffice não a oferece.
      audience: 'app',
    });
  }

  private async resolveOrCreateAccount(
    facebookIdentity: {
      subject: string;
      email: string | null;
      name: string;
    },
    selectedPlanId?: string,
  ): Promise<Account> {
    const linkedIdentity =
      await this.accountProviderIdentitiesRepository.findByProviderSubject(
        'facebook',
        facebookIdentity.subject,
      );

    if (linkedIdentity) {
      const account = await this.accountsRepository.findById(
        linkedIdentity.accountId,
      );

      if (!account) {
        throw new InternalServerErrorException({
          code: 'FACEBOOK_ACCOUNT_LINK_INVALID',
          message: 'Facebook account link is invalid',
        });
      }

      return account;
    }

    if (!facebookIdentity.email) {
      throw new BadRequestException({
        code: 'FACEBOOK_EMAIL_REQUIRED',
        message:
          'Facebook account did not provide an email. Please grant email permission and try again.',
      });
    }

    let account = await this.accountsRepository.findByEmail(
      facebookIdentity.email,
    );

    if (!account) {
      // A rota é de login, e é aqui que ela vira cadastro: sem conta para este
      // e-mail, o primeiro login por Facebook cria uma. Com o cadastro fechado
      // é este ramo que precisa recusar - o de cima, com conta existente,
      // continua entrando normalmente.
      assertRegistrationEnabled(this.env);

      // O plano escolhido na vitrine, conferido como no cadastro por senha.
      // Sem ele a organização nascia no teste gratuito, com o produto aberto,
      // para quem tinha clicado em Profissional. Só neste ramo: quem já tem
      // conta não troca de plano por ter entrado pelo Facebook.
      await assertSelectablePlan(this.plansRepository, selectedPlanId);

      const passwordHash = await this.passwordHasher.hash(
        randomBytes(32).toString('base64url'),
      );

      account = Account.create({
        name: facebookIdentity.name,
        email: facebookIdentity.email,
        passwordHash,
        // Facebook vouched for this address, so no confirmation step is needed.
        emailVerified: true,
        // Lido pelo onboarding logo abaixo, que provisiona a organização.
        selectedPlanId,
      });

      await this.accountsRepository.save(account);
      await this.onboarding.execute(account, { sendWelcomeEmail: true });
    }

    // Antes do vínculo: sem isto a identidade federada ficava presa à conta
    // de operador mesmo com a sessão recusada logo em seguida.
    assertCustomerAccount(account);

    await this.linkFacebookIdentity(account.id, facebookIdentity);

    return account;
  }

  private async linkFacebookIdentity(
    accountId: string,
    facebookIdentity: { subject: string; email: string | null },
  ): Promise<void> {
    try {
      await this.accountProviderIdentitiesRepository.save(
        AccountProviderIdentity.create({
          accountId,
          provider: 'facebook',
          providerSubject: facebookIdentity.subject,
          email: facebookIdentity.email ?? '',
        }),
      );
    } catch {
      const linkedIdentity =
        await this.accountProviderIdentitiesRepository.findByProviderSubject(
          'facebook',
          facebookIdentity.subject,
        );

      if (linkedIdentity?.accountId !== accountId) {
        throw new UnauthorizedException({
          code: 'FACEBOOK_ACCOUNT_ALREADY_LINKED',
          message: 'Facebook account is already linked to another user',
        });
      }
    }
  }
}
