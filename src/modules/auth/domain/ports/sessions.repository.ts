import { Session } from '../entities/session.entity';

export abstract class SessionsRepositoryInterface {
  abstract save(session: Session): Promise<void>;
  abstract update(session: Session): Promise<void>;
  abstract findById(id: string): Promise<Session | null>;
  abstract findByRefreshTokenHash(
    refreshTokenHash: string,
  ): Promise<Session | null>;
  abstract revokeAllByAccountId(accountId: string): Promise<void>;
  abstract listAllByAccountId(accountId: string): Promise<Session[]>;
}
