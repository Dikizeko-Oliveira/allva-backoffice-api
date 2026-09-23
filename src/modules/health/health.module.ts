import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { MediaModule } from 'src/shared/infrastructure/media/media.module';
import { HEALTH_QUEUE, HealthController } from './health.controller';

@Module({
  imports: [BullModule.registerQueue({ name: HEALTH_QUEUE }), MediaModule],
  controllers: [HealthController],
})
export class HealthModule {}
