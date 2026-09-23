import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { UpdatePreferenceInputDto, UpdatePreferenceOutputDto } from '../dtos';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';

@Injectable()
export class UpdatePreferenceUseCase {
  constructor(
    private readonly preferencesRepository: PreferencesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
  ) {}

  async execute(
    input: UpdatePreferenceInputDto,
    accountId: string,
  ): Promise<UpdatePreferenceOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const preference =
      await this.preferencesRepository.findByAccountId(accountId);

    if (!preference) {
      throw new NotFoundException({
        code: 'PREFERENCE_NOT_FOUND',
        message: 'Preference not found',
      });
    }

    preference.update({
      notificationByEmail: input.notificationByEmail,
      dailyResume: input.dailyResume,
      alertNotifications: input.alertNotifications,
      promotionNotifications: input.promotionNotifications,
      productNewsNotification: input.productNewsNotification,
    });

    await this.preferencesRepository.update(preference);

    return {};
  }
}
