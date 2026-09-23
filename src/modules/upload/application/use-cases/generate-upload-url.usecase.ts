import { Injectable } from '@nestjs/common';
import { StoragePortInterface } from 'src/shared/application/ports/storage.port';

@Injectable()
export class GenerateUploadUrlUseCase {
  constructor(private readonly storagePort: StoragePortInterface) {}

  async execute(
    filename: string,
    mimeType: string,
    campaignName?: string,
  ): Promise<{ uploadUrl: string; fileUrl: string; key: string }> {
    return this.storagePort.getPresignedUrl(
      filename,
      mimeType,
      'creatives/assets',
      campaignName,
    );
  }
}
