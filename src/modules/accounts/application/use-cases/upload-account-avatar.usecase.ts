import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';
import { Account } from 'src/modules/accounts/domain/entities';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';

type UploadAccountAvatarInput = {
  accountId: string;
  file?: Express.Multer.File;
};

@Injectable()
export class UploadAccountAvatarUseCase {
  private readonly logger = new Logger(UploadAccountAvatarUseCase.name);

  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly storagePort: StoragePortInterface,
  ) {}

  async execute(input: UploadAccountAvatarInput): Promise<Account> {
    if (!input.file) {
      throw new BadRequestException({
        code: 'FILE_REQUIRED',
        message: 'File is required',
      });
    }

    const account = await this.accountsRepository.findById(input.accountId);

    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    const { url } = await this.storagePort.upload(
      input.file.buffer,
      input.file.originalname,
      input.file.mimetype,
      'accounts/avatars',
      account.name,
    );

    await this.accountsRepository.updateAccount(input.accountId, {
      avatarUrl: url,
    });

    const updatedAccount = await this.accountsRepository.findById(
      input.accountId,
    );

    if (!updatedAccount) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }

    if (account.avatarUrl) {
      try {
        await this.storagePort.deleteByUrl(account.avatarUrl);
      } catch {
        this.logger.warn(
          `Could not delete previous avatar for account ${input.accountId}`,
        );
      }
    }

    return updatedAccount;
  }
}
