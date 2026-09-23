import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { CreatePreferenceInputDto, CreatePreferenceOutputDto } from '../dtos';
import { Preference } from 'src/modules/preferences/domain/entities';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';

@Injectable()
export class CreatePreferenceUseCase {
  constructor(
    private readonly preferencesRepository: PreferencesRepositoryInterface,
    private readonly accountsRepository: AccountsRepositoryInterface,
  ) {}

  async execute(
    input: CreatePreferenceInputDto,
    accountId: string,
  ): Promise<CreatePreferenceOutputDto> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const existingPreference =
      await this.preferencesRepository.findByAccountId(accountId);

    if (existingPreference) {
      throw new BadRequestException({
        code: 'PREFERENCE_ALREADY_EXISTS',
        message: 'Preference already exists for account',
      });
    }

    const preference = Preference.create({
      accountId,
      notificationByEmail: input.notificationByEmail,
      dailyResume: input.dailyResume,
      alertNotifications: input.alertNotifications,
      promotionNotifications: input.promotionNotifications,
      productNewsNotification: input.productNewsNotification,
    });

    await this.preferencesRepository.save(preference);

    return { id: preference.id };
  }
}
