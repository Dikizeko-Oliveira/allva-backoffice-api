import { spawn } from 'node:child_process';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  VideoPreviewFrame,
  VideoProcessingPortInterface,
} from 'src/modules/creative-lab/domain/ports/video-processing.port';
import { FfmpegBinaryLocator } from 'src/shared/infrastructure/media/ffmpeg-binary.locator';

/** Hard ceiling for one extraction. Remote reads make this mostly network-bound. */
const EXTRACTION_TIMEOUT_MS = 30_000;
/** A single JPEG frame far exceeding this means ffmpeg is not producing a frame. */
const MAX_FRAME_BYTES = 5 * 1024 * 1024;

@Injectable()
export class FfmpegVideoProcessor implements VideoProcessingPortInterface {
  private readonly logger = new Logger(FfmpegVideoProcessor.name);

  constructor(private readonly binaryLocator: FfmpegBinaryLocator) {}

  async extractFirstFrame(videoUrl: string): Promise<VideoPreviewFrame> {
    const source = this.assertRemoteHttpUrl(videoUrl);
    const binary = this.resolveBinaryPath();

    const buffer = await this.runFfmpeg(binary, [
      '-hide_banner',
      '-loglevel',
      'error',
      // Playlist-based inputs (HLS/DASH) can reference arbitrary URLs. Keeping
      // `file` out of the whitelist stops a crafted manifest from making ffmpeg
      // read the local filesystem.
      '-protocol_whitelist',
      'http,https,tcp,tls,crypto',
      '-i',
      source,
      '-frames:v',
      '1',
      '-f',
      'image2',
      '-c:v',
      'mjpeg',
      '-q:v',
      '2',
      'pipe:1',
    ]);

    if (!buffer.length) {
      throw new UnprocessableEntityException({
        code: 'VIDEO_PREVIEW_EMPTY_FRAME',
        message: 'ffmpeg produced no frame for the given video',
      });
    }

    this.logger.log(
      `Extracted first frame (${buffer.length} bytes) from ${source}`,
    );

    return { buffer, mimeType: 'image/jpeg', extension: 'jpg' };
  }

  /**
   * ffmpeg is spawned without a shell, so there is no command injection — but an
   * unvalidated URL still lets a caller reach `file://`, `concat:` and friends.
   * Only absolute http(s) URLs are accepted.
   */
  private assertRemoteHttpUrl(videoUrl: string): string {
    let parsed: URL;

    try {
      parsed = new URL(videoUrl);
    } catch {
      throw new UnprocessableEntityException({
        code: 'VIDEO_PREVIEW_INVALID_SOURCE',
        message: 'Creative source URL is not a valid absolute URL',
      });
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new UnprocessableEntityException({
        code: 'VIDEO_PREVIEW_INVALID_SOURCE',
        message: 'Creative source URL must use http or https',
      });
    }

    return parsed.toString();
  }

  private resolveBinaryPath(): string {
    const binary = this.binaryLocator.resolvePath();

    if (!binary) {
      throw new ServiceUnavailableException({
        code: 'VIDEO_PREVIEW_FFMPEG_UNAVAILABLE',
        message: 'No ffmpeg binary available for video preview extraction',
      });
    }

    return binary;
  }

  private runFfmpeg(binary: string, args: string[]): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      const chunks: Buffer[] = [];
      let bytes = 0;
      let stderr = '';
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(error);
      };

      const timer = setTimeout(() => {
        fail(
          new ServiceUnavailableException({
            code: 'VIDEO_PREVIEW_TIMEOUT',
            message: `ffmpeg timed out after ${EXTRACTION_TIMEOUT_MS}ms`,
          }),
        );
      }, EXTRACTION_TIMEOUT_MS);
      // Never hold the event loop open on account of the watchdog.
      timer.unref?.();

      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;

        if (bytes > MAX_FRAME_BYTES) {
          fail(
            new UnprocessableEntityException({
              code: 'VIDEO_PREVIEW_FRAME_TOO_LARGE',
              message: `Extracted frame exceeded ${MAX_FRAME_BYTES} bytes`,
            }),
          );
          return;
        }

        chunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        // Bounded so a chatty failure cannot grow without limit.
        stderr = (stderr + chunk.toString()).slice(-2000);
      });

      child.on('error', (error) => {
        fail(
          new ServiceUnavailableException({
            code: 'VIDEO_PREVIEW_FFMPEG_UNAVAILABLE',
            message: `Failed to run ffmpeg: ${error.message}`,
          }),
        );
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (settled) return;
        settled = true;

        if (code !== 0) {
          reject(
            new UnprocessableEntityException({
              code: 'VIDEO_PREVIEW_EXTRACTION_FAILED',
              message: `ffmpeg exited with code ${code}: ${stderr.trim()}`,
            }),
          );
          return;
        }

        resolve(Buffer.concat(chunks));
      });
    });
  }
}
