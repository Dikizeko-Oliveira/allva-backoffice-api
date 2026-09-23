import { Module } from '@nestjs/common';
import { GenerateUploadUrlUseCase } from 'src/modules/upload/application/use-cases/generate-upload-url.usecase';
import { UploadController } from 'src/modules/upload/infrastructure/http/controllers/upload.controller';
import { SubscriptionAccessModule } from 'src/modules/subscriptions/access/subscription-access.module';
import { StorageModule } from 'src/shared/infrastructure/storage/storage.module';

@Module({
  imports: [StorageModule, SubscriptionAccessModule],
  controllers: [UploadController],
  providers: [GenerateUploadUrlUseCase],
  exports: [GenerateUploadUrlUseCase],
})
export class UploadModule {}
