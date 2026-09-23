import { Injectable, NotFoundException } from '@nestjs/common';
import { ListPreferenceOutputDto } from '../dtos';
import { PreferencesRepositoryInterface } from 'src/modules/preferences/domain/ports';

@Injectable()
export class ListPreferenceUseCase {
  constructor(
    private readonly preferencesRepository: PreferencesRepositoryInterface,
  ) {}

  async execute(accountId: string): Promise<ListPreferenceOutputDto> {
    const preference =
      await this.preferencesRepository.findByAccountId(accountId);

    if (!preference) {
      throw new NotFoundException({
        code: 'PREFERENCE_NOT_FOUND',
        message: 'Preference not found',
      });
    }

    return { preference: preference.toJSON() };
  }
}
