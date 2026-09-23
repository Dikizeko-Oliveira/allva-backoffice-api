import { PasswordResetToken } from '../entities';

export abstract class PasswordResetTokensRepositoryInterface {
  abstract create(token: PasswordResetToken): Promise<void>;
  abstract findValidByToken(token: string): Promise<PasswordResetToken | null>;
  abstract invalidate(tokenId: string): Promise<void>;
  abstract invalidateAllByAccountId(accountId: string): Promise<void>;
}
