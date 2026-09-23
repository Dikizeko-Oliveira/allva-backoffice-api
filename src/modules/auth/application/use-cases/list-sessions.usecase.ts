import { Injectable } from '@nestjs/common';
import { SessionsRepositoryInterface } from 'src/modules/auth/domain/ports';
import { Session } from 'src/modules/auth/domain/entities';

@Injectable()
export class ListSessionsUseCase {
  constructor(
    private readonly sessionsRepository: SessionsRepositoryInterface,
  ) {}

  async execute(accountId: string): Promise<Session[]> {
    const sessions =
      await this.sessionsRepository.listAllByAccountId(accountId);

    return sessions;
  }
}
