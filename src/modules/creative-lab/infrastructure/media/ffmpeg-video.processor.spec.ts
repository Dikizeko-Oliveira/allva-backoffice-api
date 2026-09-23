import { execFile } from 'node:child_process';
import { createServer, Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AddressInfo } from 'node:net';
import ffmpegStaticPath from 'ffmpeg-static';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { FfmpegBinaryLocator } from 'src/shared/infrastructure/media/ffmpeg-binary.locator';
import { FfmpegVideoProcessor } from './ffmpeg-video.processor';

const execFileAsync = promisify(execFile);

/** JPEG SOI + APP0/APP1 marker — proof the output is a real decoded image. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

describe('FfmpegVideoProcessor', () => {
  let processor: FfmpegVideoProcessor;
  let workDir: string;
  let videoBytes: Buffer;
  let server: Server;
  let baseUrl: string;
  /** Stands in for FFMPEG_PATH; `undefined` falls back to the bundled binary. */
  let ffmpegPathOverride: string | undefined;

  beforeAll(async () => {
    // A real locator over a stubbed env, so the resolution rule
    // (FFMPEG_PATH > ffmpeg-static) is exercised rather than mocked away.
    const env = {
      get: (key: string) =>
        key === 'FFMPEG_PATH' ? ffmpegPathOverride : undefined,
    } as unknown as EnvService;

    processor = new FfmpegVideoProcessor(new FfmpegBinaryLocator(env));
    workDir = await mkdtemp(join(tmpdir(), 'allva-video-preview-'));

    // A real (tiny) mp4 built by ffmpeg itself, so the test exercises actual
    // decoding rather than a stubbed byte stream.
    const fixturePath = join(workDir, 'fixture.mp4');
    await execFileAsync(ffmpegStaticPath as string, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
    videoBytes = await readFile(fixturePath);

    server = createServer((req, res) => {
      if (req.url === '/fixture.mp4') {
        res.writeHead(200, {
          'content-type': 'video/mp4',
          'content-length': String(videoBytes.length),
        });
        res.end(videoBytes);
        return;
      }

      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(workDir, { recursive: true, force: true });
  });

  it('extracts a real JPEG first frame from a remote video', async () => {
    const frame = await processor.extractFirstFrame(`${baseUrl}/fixture.mp4`);

    expect(frame.mimeType).toBe('image/jpeg');
    expect(frame.extension).toBe('jpg');
    expect(frame.buffer.length).toBeGreaterThan(0);
    expect(frame.buffer.subarray(0, 3)).toEqual(JPEG_MAGIC);
    // One 320x240 still stays well under the processor's 5MB frame ceiling.
    expect(frame.buffer.length).toBeLessThan(5 * 1024 * 1024);
  }, 60_000);

  it('fails when the source cannot be fetched', async () => {
    await expect(
      processor.extractFirstFrame(`${baseUrl}/missing.mp4`),
    ).rejects.toMatchObject({
      response: { code: 'VIDEO_PREVIEW_EXTRACTION_FAILED' },
    });
  }, 60_000);

  it.each([
    ['file:///etc/passwd'],
    ['concat:/etc/passwd'],
    ['/var/data/local.mp4'],
    ['not a url'],
  ])('refuses the non-http source %s', async (source) => {
    await expect(processor.extractFirstFrame(source)).rejects.toMatchObject({
      response: { code: 'VIDEO_PREVIEW_INVALID_SOURCE' },
    });
  });

  it('reports ffmpeg being unavailable instead of hanging', async () => {
    ffmpegPathOverride = join(workDir, 'does-not-exist');

    try {
      await expect(
        processor.extractFirstFrame(`${baseUrl}/fixture.mp4`),
      ).rejects.toMatchObject({
        response: { code: 'VIDEO_PREVIEW_FFMPEG_UNAVAILABLE' },
      });
    } finally {
      ffmpegPathOverride = undefined;
    }
  }, 60_000);
});
