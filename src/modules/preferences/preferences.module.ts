import { Module } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { AccountsPrismaRepository } from 'src/modules/accounts/infrastructure/database/prisma/accounts-prisma.repository';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';
import { PreferencesPrismaRepository } from 'src/modules/preferences/infrastructure/database/prisma/preferences-prisma.repository';
import { AccountsPreferencesController } from 'src/modules/preferences/infrastructure/http/controllers/accounts-preferences.controller';
import {
  CreatePreferenceUseCase,
  ListPreferenceUseCase,
  UpdatePreferenceUseCase,
} from 'src/modules/preferences/application/use-cases';
import { EmailPreferenceGate } from 'src/modules/preferences/application/services/email-preference-gate.service';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';

@Module({
  imports: [SubscriptionAccessModule],
  controllers: [AccountsPreferencesController],
  providers: [
    CreatePreferenceUseCase,
    UpdatePreferenceUseCase,
    ListPreferenceUseCase,
    EmailPreferenceGate,
    {
      provide: PreferencesRepositoryInterface,
      useClass: PreferencesPrismaRepository,
    },
    {
      provide: AccountsRepositoryInterface,
      useClass: AccountsPrismaRepository,
    },
  ],
  exports: [EmailPreferenceGate],
})
export class PreferencesModule {}
