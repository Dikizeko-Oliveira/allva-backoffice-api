import { Module } from '@nestjs/common';
import { GetOperatorAttentionUseCase } from './application/use-cases';
import { AttentionCountsReaderInterface } from './domain/ports';
import { AttentionCountsPrismaReader } from './infrastructure/database/prisma/attention-counts-prisma.reader';
import { HubAttentionController } from './infrastructure/http/controllers/hub-attention.controller';

/**
 * Módulo próprio, e não um canto de `support` ou `alerts`: ele lê das tabelas
 * dos dois, e pendurá-lo em qualquer um faria esse módulo depender do outro. A
 * dependência aqui é só de leitura.
 */
@Module({
  controllers: [HubAttentionController],
  providers: [
    GetOperatorAttentionUseCase,
    {
      provide: AttentionCountsReaderInterface,
      useClass: AttentionCountsPrismaReader,
    },
  ],
})
export class OperationsHubModule {}
