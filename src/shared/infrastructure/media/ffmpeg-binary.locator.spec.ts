import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import ffmpegStaticPath from 'ffmpeg-static';
import { EnvService } from 'src/shared/infrastructure/config/env.service';
import { FfmpegBinaryLocator } from './ffmpeg-binary.locator';

type EnvOverrides = {
  FFMPEG_PATH?: string;
  VIDEO_PREVIEW_ENABLED?: boolean;
};

function locatorWith(overrides: EnvOverrides): FfmpegBinaryLocator {
  const env = {
    get: (key: keyof EnvOverrides) => overrides[key],
  } as unknown as EnvService;

  return new FfmpegBinaryLocator(env);
}

describe('FfmpegBinaryLocator', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'allva-ffmpeg-locator-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe('resolvePath', () => {
    it('prefers FFMPEG_PATH over the bundled binary', () => {
      const locator = locatorWith({ FFMPEG_PATH: '/opt/custom/ffmpeg' });

      expect(locator.resolvePath()).toBe('/opt/custom/ffmpeg');
    });

    it('trims FFMPEG_PATH and ignores a blank value', () => {
      expect(
        locatorWith({ FFMPEG_PATH: '  /opt/ffmpeg  ' }).resolvePath(),
      ).toBe('/opt/ffmpeg');
      // A whitespace-only override is a misconfiguration, not an instruction to
      // have no ffmpeg at all — fall back to the bundled build.
      expect(locatorWith({ FFMPEG_PATH: '   ' }).resolvePath()).toBe(
        ffmpegStaticPath,
      );
    });

    it('falls back to the ffmpeg-static binary when unset', () => {
      expect(locatorWith({}).resolvePath()).toBe(ffmpegStaticPath);
    });
  });

  describe('probe', () => {
    it('reports disabled when the kill switch is off, without touching the disk', async () => {
      const locator = locatorWith({
        VIDEO_PREVIEW_ENABLED: false,
        FFMPEG_PATH: join(workDir, 'does-not-exist'),
      });

      await expect(locator.probe()).resolves.toMatchObject({
        status: 'disabled',
      });
    });

    it('reports ok for the bundled binary when the pipeline is on', async () => {
      const locator = locatorWith({ VIDEO_PREVIEW_ENABLED: true });

      await expect(locator.probe()).resolves.toMatchObject({
        status: 'ok',
        path: ffmpegStaticPath,
      });
    });

    it('reports unavailable when the configured binary is missing', async () => {
      const missing = join(workDir, 'missing-ffmpeg');
      const locator = locatorWith({
        VIDEO_PREVIEW_ENABLED: true,
        FFMPEG_PATH: missing,
      });

      const probe = await locator.probe();

      expect(probe.status).toBe('unavailable');
      expect(probe.path).toBe(missing);
      expect(probe.reason).toContain(missing);
    });

    it('reports unavailable when the binary exists but is not executable', async () => {
      const notExecutable = join(workDir, 'not-executable');
      await writeFile(notExecutable, '#!/bin/sh\n');
      await chmod(notExecutable, 0o644);

      const locator = locatorWith({
        VIDEO_PREVIEW_ENABLED: true,
        FFMPEG_PATH: notExecutable,
      });

      // This is the failure mode a pruned/rebuilt image actually produces: the
      // file survives, the exec bit does not.
      await expect(locator.probe()).resolves.toMatchObject({
        status: 'unavailable',
      });
    });

    it('never throws — a missing accessory dependency must not break /health', async () => {
      const locator = locatorWith({
        VIDEO_PREVIEW_ENABLED: true,
        FFMPEG_PATH: join(workDir, 'nested', 'deeper', 'nope'),
      });

      await expect(locator.probe()).resolves.toMatchObject({
        status: 'unavailable',
      });
    });
  });

  describe('onApplicationBootstrap', () => {
    it('logs an error (and does not throw) when ffmpeg is unavailable', async () => {
      const locator = locatorWith({
        VIDEO_PREVIEW_ENABLED: true,
        FFMPEG_PATH: join(workDir, 'absent'),
      });
      const error = jest
        .spyOn((locator as any).logger, 'error')
        .mockImplementation(() => undefined);

      await expect(locator.onApplicationBootstrap()).resolves.toBeUndefined();

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('video_preview.ffmpeg_unavailable'),
      );
      error.mockRestore();
    });

    it('logs readiness when the binary resolves', async () => {
      const locator = locatorWith({ VIDEO_PREVIEW_ENABLED: true });
      const log = jest
        .spyOn((locator as any).logger, 'log')
        .mockImplementation(() => undefined);

      await locator.onApplicationBootstrap();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('video_preview.ffmpeg_ready'),
      );
      log.mockRestore();
    });

    it('logs the pipeline being off instead of warning', async () => {
      const locator = locatorWith({ VIDEO_PREVIEW_ENABLED: false });
      const log = jest
        .spyOn((locator as any).logger, 'log')
        .mockImplementation(() => undefined);
      const error = jest
        .spyOn((locator as any).logger, 'error')
        .mockImplementation(() => undefined);

      await locator.onApplicationBootstrap();

      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('video_preview.disabled'),
      );
      expect(error).not.toHaveBeenCalled();
      log.mockRestore();
      error.mockRestore();
    });
  });
});
