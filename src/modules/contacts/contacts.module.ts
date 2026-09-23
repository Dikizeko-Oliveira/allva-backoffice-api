import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { ContactsRepositoryInterface } from './domain/ports';
import { ContactsPrismaRepository } from './infrastructure/database/prisma/contacts-prisma.repository';
import { ContactsController } from './infrastructure/http/controllers/contacts.controller';
import {
  CreateContactUseCase,
  GetContactUseCase,
  ListContactsUseCase,
  UpdateContactStatusUseCase,
} from './application/use-cases';

@Module({
  imports: [
    // `PlatformRoleService` — a caixa de entrada é do operador (B11).
    AccountsModule,
    // Scoped rate limiting for this module: 30 req/min default, with a stricter
    // per-route limit on the public contact creation endpoint.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 30 }]),
  ],
  controllers: [ContactsController],
  providers: [
    CreateContactUseCase,
    ListContactsUseCase,
    GetContactUseCase,
    UpdateContactStatusUseCase,
    {
      provide: ContactsRepositoryInterface,
      useClass: ContactsPrismaRepository,
    },
  ],
})
export class ContactsModule {}
