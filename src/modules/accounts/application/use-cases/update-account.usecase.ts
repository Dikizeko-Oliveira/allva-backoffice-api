import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AccountsRepositoryInterface,
  UpdateAccountProps,
} from 'src/modules/accounts/domain/ports';
import type { Account } from 'src/modules/accounts/domain/entities';
import { AuditLogService } from 'src/modules/audit/application';

interface AccountRequest extends UpdateAccountProps {
  accountId: string;
}

@Injectable()
export class UpdateAccountUseCase {
  constructor(
    private accountsRepository: AccountsRepositoryInterface,
    private readonly auditLog: AuditLogService,
  ) {}

  async execute({ accountId, ...data }: AccountRequest): Promise<Account> {
    const account = await this.accountsRepository.findById(accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    await this.accountsRepository.updateAccount(accountId, data);

    const updatedAccount = await this.accountsRepository.findById(accountId);

    if (!updatedAccount) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    // Field names only — an audit trail should say what changed, never carry the
    // new values (which include personal data like address and phone).
    await this.auditLog.record({
      event: 'account.updated',
      entityType: 'account',
      entityId: accountId,
      actorId: accountId,
      metadata: { fields: Object.keys(data ?? {}) },
    });

    return updatedAccount;
  }
}
