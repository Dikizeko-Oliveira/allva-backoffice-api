import { Injectable, NotFoundException } from '@nestjs/common';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import { Account } from 'src/modules/accounts/domain/entities';

@Injectable()
export class GetAccountUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
  ) {}

  async execute(accountId: string): Promise<Account> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    return account;
  }
}
