import { Module } from '@nestjs/common';
import { ContractDraftsController } from './contract-drafts.controller';

@Module({
  controllers: [ContractDraftsController],
})
export class ContractDraftsModule {}
