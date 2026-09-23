import { Module } from '@nestjs/common';
import { FfmpegBinaryLocator } from './ffmpeg-binary.locator';

/**
 * Shared home for the ffmpeg binary probe: the campaigns module needs it to run
 * extractions, and the health module needs it to report readiness. A dedicated
 * module keeps `HealthModule` from having to import all of `CampaignsModule`
 * (controllers, queues and workers) just to answer one question.
 */
@Module({
  providers: [FfmpegBinaryLocator],
  exports: [FfmpegBinaryLocator],
})
export class MediaModule {}
