import { Preference } from '../entities';

export abstract class PreferencesRepositoryInterface {
  abstract save(preference: Preference): Promise<void>;
  abstract update(preference: Preference): Promise<void>;
  abstract findByAccountId(accountId: string): Promise<Preference | null>;
}
