import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Account } from 'src/modules/accounts/domain/entities/account.entity';
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
  PasswordHasherInterface,
} from 'src/modules/auth/domain/ports';
import { AccountOnboardingService } from 'src/modules/accounts/application/services/account-onboarding.service';
import { assertRegistrationEnabled } from 'src/modules/accounts/application/assert-registration-enabled';
import { assertSelectablePlan } from 'src/modules/plans/application/assert-selectable-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { IssueAuthSessionUseCase } from './issue-auth-session.usecase';

@Injectable()
export class RegisterWithGoogleUseCase {
  constructor(
    private readonly googleIdentityVerifier: GoogleIdentityVerifierInterface,
    private readonly accountProviderIdentitiesRepository: AccountProviderIdentitiesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly issueAuthSessionUseCase: IssueAuthSessionUseCase,
    private readonly onboarding: AccountOnboardingService,
    private readonly env: EnvService,
    private readonly plansRepository: PlansRepositoryInterface,
  ) {}

  async execute(
    input: LoginWithGoogleInputDto,
  ): Promise<LoginWithPasswordOutputDto> {
    const googleIdentity = await this.googleIdentityVerifier.verifyIdToken(
      input.idToken,
    );

    const account = await this.resolveOrCreateAccount(
      googleIdentity,
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
    googleIdentity: {
      subject: string;
      email: string;
      name: string;
    },
    selectedPlanId?: string,
  ): Promise<Account> {
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

    let account = await this.accountsRepository.findByEmail(
      googleIdentity.email,
    );

    if (!account) {
      // A rota se chama `register`, mas quem já tem conta também passa por ela:
      // a recusa fica aqui dentro, onde a conta seria criada, para que um
      // tester com conta continue entrando pelo Google com o cadastro fechado.
      assertRegistrationEnabled(this.env);

      // O plano escolhido na vitrine, conferido como no cadastro por senha.
      // Sem ele a organização nascia no teste gratuito, com o produto aberto,
      // para quem tinha clicado em Profissional. Só neste ramo: quem já tem
      // conta não troca de plano por ter entrado pelo Google.
      await assertSelectablePlan(this.plansRepository, selectedPlanId);

      const passwordHash = await this.passwordHasher.hash(
        randomBytes(32).toString('base64url'),
      );

      account = Account.create({
        name: googleIdentity.name,
        email: googleIdentity.email,
        passwordHash,
        // The Google verifier already rejects unverified addresses upstream.
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

    await this.linkGoogleIdentity(account.id, googleIdentity);

    return account;
  }

  private async linkGoogleIdentity(
    accountId: string,
    googleIdentity: { subject: string; email: string },
  ): Promise<void> {
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
