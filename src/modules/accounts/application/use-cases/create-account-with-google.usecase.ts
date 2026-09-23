import { ConflictException, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AccountsRepositoryInterface } from 'src/modules/accounts/domain/ports';
import {
  CreateAccountWithPasswordInputDto,
  CreateAccountWithPasswordOutputDto,
} from 'src/modules/accounts/application/dtos';
import { CreateAccountWithPasswordUseCase } from 'src/modules/accounts/application/use-cases/create-account-with-password.usecase';

type CreateAccountWithGoogleInput = Pick<
  CreateAccountWithPasswordInputDto,
  'email' | 'name'
>;

@Injectable()
export class CreateAccountWithGoogleUseCase {
  constructor(
    private readonly accountsRepository: AccountsRepositoryInterface,
    private readonly createAccountWithPasswordUseCase: CreateAccountWithPasswordUseCase,
  ) {}

  async execute(
    input: CreateAccountWithGoogleInput,
  ): Promise<CreateAccountWithPasswordOutputDto> {
    const email = input.email.trim().toLowerCase();
    const existingAccount = await this.accountsRepository.findByEmail(email);

    if (existingAccount) {
      throw new ConflictException({
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'User already exists. Please login instead.',
      });
    }

    const generatedPassword = randomBytes(32).toString('base64url');

    return this.createAccountWithPasswordUseCase.execute(
      {
        email,
        name: input.name,
        password: generatedPassword,
      },
      // Google already verified this address, so no confirmation is required.
      { emailVerified: true, signupMethod: 'google' },
    );
  }
}
