import { Module } from '@nestjs/common';
import { AccountsModule } from 'src/modules/accounts/accounts.module';
import { GetOperatorAttentionUseCase } from './application/use-cases';
import { AttentionCountsReaderInterface } from './domain/ports';
import { AttentionCountsPrismaReader } from './infrastructure/database/prisma/attention-counts-prisma.reader';
import { AdminAttentionController } from './infrastructure/http/controllers/admin-attention.controller';

/**
 * Operations Hub do backoffice (`docs/workspace-screen.md`).
 *
 * Módulo próprio, e não um canto de `accounts` ou `support`: ele lê de sete
 * tabelas de cinco módulos, e pendurá-lo em qualquer um deles faria esse
 * módulo depender dos outros quatro. Aqui a dependência é só de leitura, e só
 * de `accounts` (quem é o operador).
 */
@Module({
  imports: [AccountsModule],
  controllers: [AdminAttentionController],
  providers: [
    GetOperatorAttentionUseCase,
    {
      provide: AttentionCountsReaderInterface,
      useClass: AttentionCountsPrismaReader,
    },
  ],
})
export class OperationsHubModule {}
