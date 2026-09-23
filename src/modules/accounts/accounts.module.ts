import { Module } from '@nestjs/common';
import { ArgonPasswordHasher } from 'src/modules/auth/infrastructure/services/argon-password-hasher.provider';
import {
  PasswordHasherInterface,
  PasswordResetTokensRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { PasswordResetTokensPrismaRepository } from 'src/modules/auth/infrastructure/database/prisma/password-reset-tokens-prisma.repository';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { EmailVerificationTokensPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/email-verification-tokens-prisma.repository';
import { AccountsController } from 'src/modules/accounts/infrastructure/http/controllers/accounts.controller';
import { AdminAccountsController } from 'src/modules/accounts/infrastructure/http/controllers/admin-accounts.controller';
import { UpdatePlatformRoleUseCase } from 'src/modules/accounts/application/use-cases/update-platform-role.usecase';
import {
  AccountsRepositoryInterface,
  EmailVerificationTokensRepositoryInterface,
} from 'src/modules/accounts/domain/ports';
import {
  CreateAccountWithGoogleUseCase,
  CreateAccountWithPasswordUseCase,
  CreateOperatorUseCase,
  DeleteAccountUseCase,
  GetAccountUseCase,
  SendEmailVerificationUseCase,
  UpdateAccountUseCase,
  UpdateCustomerMembershipStatusUseCase,
  UpdateOperatorStatusUseCase,
  UploadAccountAvatarUseCase,
  VerifyEmailUseCase,
} from 'src/modules/accounts/application/use-cases';
import { PlansModule } from 'src/modules/plans/plans.module';
import { PlatformRoleService } from 'src/modules/accounts/application/services/platform-role.service';
import { AccountOnboardingService } from 'src/modules/accounts/application/services/account-onboarding.service';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { PreferencesPrismaRepository } from 'src/modules/preferences/infrastructure/database/prisma/preferences-prisma.repository';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';
import { ProvisioningModule } from 'src/modules/provisioning/provisioning.module';
import { SubscriptionsModule } from 'src/modules/subscriptions/subscriptions.module';
import { OrganizationsModule } from 'src/modules/organizations/organizations.module';

@Module({
  imports: [
    // O cadastro recusa plano negociado antes de criar a conta.
    PlansModule,
    StorageModule,
    SubscriptionAccessModule,
    EmailModule,
    ProvisioningModule,
    // O encerramento de conta cancela a assinatura antes de anonimizar, e quem
    // sabe falar com a Stripe é o caso de uso de cancelamento.
    SubscriptionsModule,
    // E apaga as organizações de que o titular é dono, reusando a cascata de lá.
    OrganizationsModule,
  ],
  controllers: [AccountsController, AdminAccountsController],
  providers: [
    UpdatePlatformRoleUseCase,
    UpdateCustomerMembershipStatusUseCase,
    UpdateOperatorStatusUseCase,
    CreateOperatorUseCase,
    CreateAccountWithGoogleUseCase,
    CreateAccountWithPasswordUseCase,
    DeleteAccountUseCase,
    GetAccountUseCase,
    UpdateAccountUseCase,
    UploadAccountAvatarUseCase,
    SendEmailVerificationUseCase,
    VerifyEmailUseCase,
    AccountOnboardingService,
    PlatformRoleService,
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
    {
      provide: EmailVerificationTokensRepositoryInterface,
      useClass: EmailVerificationTokensPrismaRepository,
    },
    {
      provide: PasswordResetTokensRepositoryInterface,
      useClass: PasswordResetTokensPrismaRepository,
    },
    {
      provide: PreferencesRepositoryInterface,
      useClass: PreferencesPrismaRepository,
    },
    {
      provide: PasswordHasherInterface,
      useClass: ArgonPasswordHasher,
    },
  ],
  exports: [
    AccountsRepositoryInterface,
    PasswordHasherInterface,
    CreateAccountWithGoogleUseCase,
    CreateAccountWithPasswordUseCase,
    SendEmailVerificationUseCase,
    VerifyEmailUseCase,
    AccountOnboardingService,
    PlatformRoleService,
  ],
})
export class AccountsModule {}
