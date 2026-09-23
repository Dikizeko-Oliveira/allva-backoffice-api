import { Module } from '@nestjs/common';
import { BackofficeHealthController } from './health.controller';

@Module({
  controllers: [BackofficeHealthController],
})
export class BackofficeCommonModule {}
