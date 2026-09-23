import { ConflictException, Injectable } from '@nestjs/common';
import {
  CreateAccountWithPasswordInputDto,
  CreateAccountWithPasswordOutputDto,
} from '../dtos';
import { PasswordHasherInterface } from 'src/modules/auth/domain/ports';
import { Account } from 'src/modules/accounts/domain/entities';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountOnboardingService } from 'src/modules/accounts/application/services/account-onboarding.service';
import { SendEmailVerificationUseCase } from 'src/modules/accounts/application/use-cases/send-email-verification.usecase';
import { AuditLogService } from 'src/modules/audit/application';
import { assertSelectablePlan } from 'src/modules/plans/application/assert-selectable-plan';
import { PlansRepositoryInterface } from 'src/modules/plans/domain/ports';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { assertRegistrationEnabled } from 'src/modules/accounts/application/assert-registration-enabled';

export type CreateAccountOptions = {
  /**
   * Set by federated signups (Google/Facebook), where the provider already
   * proved ownership of the address. Never sourced from client input.
   */
  emailVerified?: boolean;
  /**
   * How the account was created, for the audit trail (M-5). Federated signups
   * delegate to this use case, so without it every account would be recorded as a
   * password signup — a lie in an append-only trail.
   */
  signupMethod?: 'password' | 'google' | 'facebook';
};

@Injectable()
export class CreateAccountWithPasswordUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly passwordHasher: PasswordHasherInterface,
    private readonly onboarding: AccountOnboardingService,
    private readonly sendEmailVerification: SendEmailVerificationUseCase,
    private readonly plansRepository: PlansRepositoryInterface,
    private readonly auditLog: AuditLogService,
    private readonly env: EnvService,
  ) {}

  async execute(
    input: CreateAccountWithPasswordInputDto,
    options: CreateAccountOptions = {},
  ): Promise<CreateAccountWithPasswordOutputDto> {
    // Antes de qualquer trabalho: nada de hash, e-mail ou linha de auditoria
    // para um cadastro que a instalação não aceita.
    assertRegistrationEnabled(this.env);

    await assertSelectablePlan(this.plansRepository, input.selectedPlanId);

    const existingAccount = await this.accountsRepository.findByEmail(
      input.email,
    );

    if (existingAccount) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'Account already exists',
      });
    }

    const passwordHash = await this.passwordHasher.hash(input.password);

    const account = Account.create({
      name: input.name,
      email: input.email,
      passwordHash,
      emailVerified: options.emailVerified ?? false,
      // Gravado **antes** do provisionamento porque é ele que o lê: o
      // onboarding decide entre teste gratuito e espera de pagamento a partir
      // deste campo — e por isso o id já foi conferido contra o catálogo acima.
      selectedPlanId: input.selectedPlanId,
    });

    await this.accountsRepository.save(account);

    await this.auditLog.record({
      event: 'account.created',
      entityType: 'account',
      entityId: account.id,
      actorId: account.id,
      metadata: { method: options.signupMethod ?? 'password' },
    });

    // Every account gets a Preference row; the welcome email waits for a
    // confirmed address, so a password signup receives it only after verifying.
    await this.onboarding.execute(account, {
      sendWelcomeEmail: account.emailVerified,
    });

    if (!account.emailVerified) {
      await this.sendEmailVerification.executeForAccount(account);
    }

    return {
      accountId: account.id,
    };
  }
}
