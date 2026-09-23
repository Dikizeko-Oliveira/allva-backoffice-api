import { AccountProviderIdentity } from 'src/modules/auth/domain/entities';

export abstract class AccountProviderIdentitiesRepositoryInterface {
  abstract findByProviderSubject(
    provider: string,
    providerSubject: string,
  ): Promise<AccountProviderIdentity | null>;

  abstract save(identity: AccountProviderIdentity): Promise<void>;
}
