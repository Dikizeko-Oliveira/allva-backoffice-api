import { Module } from '@nestjs/common';
import { SupportOperationsModule } from '../support/support-operations.module';
import { HubController } from './hub.controller';

@Module({
  imports: [SupportOperationsModule],
  controllers: [HubController],
})
export class HubModule {}
