import { Module } from '@nestjs/common';
import { SupportOperationsController } from './support-operations.controller';
import { SupportOperationsService } from './support-operations.service';

@Module({
  controllers: [SupportOperationsController],
  providers: [SupportOperationsService],
  exports: [SupportOperationsService],
})
export class SupportOperationsModule {}
