import { Module } from '@nestjs/common';
import {
  ChangePasswordUseCase,
  ForgotPasswordUseCase,
  IssueAuthSessionUseCase,
  ListSessionsUseCase,
  LoginWithFacebookUseCase,
  LoginWithGoogleUseCase,
  LoginWithPasswordUseCase,
  RefreshSessionUseCase,
  RegisterWithGoogleUseCase,
  ResetPasswordUseCase,
  RevokeSessionUseCase,
} from 'src/modules/auth/application/use-cases';
import { AuthController } from 'src/modules/auth/infrastructure/http/controllers/auth.controller';
import {
  AccountProviderIdentitiesRepositoryInterface,
  FacebookIdentityVerifierInterface,
  GoogleIdentityVerifierInterface,
  JwtServiceInterface,
  PasswordResetTokensRepositoryInterface,
  SessionsRepositoryInterface,
} from 'src/modules/auth/domain/ports';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { PlansModule } from 'src/modules/plans/plans.module';
import { AccountProviderIdentitiesPrismaRepository } from 'src/modules/auth/infrastructure/database/prisma/account-provider-identities-prisma.repository';
import { JwtJoseProvider } from 'src/modules/auth/infrastructure/services/jwt-jose.provider';
import { PasswordResetTokensPrismaRepository } from 'src/modules/auth/infrastructure/database/prisma/password-reset-tokens-prisma.repository';
import { SessionsPrismaRepository } from 'src/modules/auth/infrastructure/database/prisma/sessions-prisma.repository';
import { FacebookAccessTokenVerifier } from 'src/modules/auth/infrastructure/services/facebook-access-token.verifier';
import { GoogleIdTokenVerifier } from 'src/modules/auth/infrastructure/services/google-id-token.verifier';
import { EmailModule } from 'src/shared/infrastructure/email/email.module';

@Module({
  // `PlansModule`: Google e Facebook também criam conta, e conferem o plano
  // escolhido na vitrine como o cadastro por senha.
  imports: [AccountsModule, EmailModule, PlansModule],
  controllers: [AuthController],
  providers: [
    ChangePasswordUseCase,
    IssueAuthSessionUseCase,
    LoginWithPasswordUseCase,
    LoginWithFacebookUseCase,
    LoginWithGoogleUseCase,
    RegisterWithGoogleUseCase,
    RefreshSessionUseCase,
    RevokeSessionUseCase,
    ListSessionsUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    {
      provide: FacebookIdentityVerifierInterface,
      useClass: FacebookAccessTokenVerifier,
    },
    {
      provide: GoogleIdentityVerifierInterface,
      useClass: GoogleIdTokenVerifier,
    },
    {
      provide: AccountProviderIdentitiesRepositoryInterface,
      useClass: AccountProviderIdentitiesPrismaRepository,
    },
    {
      provide: SessionsRepositoryInterface,
      useClass: SessionsPrismaRepository,
    },
    {
      provide: PasswordResetTokensRepositoryInterface,
      useClass: PasswordResetTokensPrismaRepository,
    },
    {
      provide: JwtServiceInterface,
      useClass: JwtJoseProvider,
    },
  ],
  exports: [JwtServiceInterface, SessionsRepositoryInterface],
})
export class AuthModule {}
